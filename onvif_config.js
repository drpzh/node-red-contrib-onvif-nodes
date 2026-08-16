/**
 * Copyright 2018 Bart Butenaers
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modified by drpzhu for improved Tapo camera connection stability:
 *  - Exponential backoff with jitter for reconnection (prevents thundering herd
 *    when many cameras drop simultaneously, e.g. after a switch reboot).
 *  - Fresh onvif.Cam instance created on each reconnect (same pattern as Shinobi NVR).
 *  - New 'reconnecting' status emitted to downstream nodes.
 *  - Auto-reconnect loop replaces passive health-check-only approach.
 **/
module.exports = function (RED) {
    var settings = RED.settings;
    const onvif = require('onvif');
    const http = require('http');

    // Shared keep-alive agent for all ONVIF cameras.
    // Reduces TCP churn on Tapo C100 cameras that aggressively close idle connections.
    const keepAliveAgent = new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 10000,
        maxSockets: 2,       // per camera host — avoid overloading the camera
        maxFreeSockets: 1,
        timeout: 30000
    });

    function setOnvifStatus(node, onvifStatus) {
        node.onvifStatus = onvifStatus;
        // Pass the new status to all the available listeners
        node.emit('onvif_status', onvifStatus);
    }

    function OnVifConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.xaddress = config.xaddress;
        this.port = parseInt(config.port || 80);
        this.name = config.name;
        this.timeout = parseInt(config.timeout || 30);
        this.checkConnectionInterval = parseInt(config.checkConnectionInterval || 5);
        // Reconnect settings: initial delay (s) and max delay cap (s)
        this.reconnectDelay = parseInt(config.reconnectDelay || 5);
        this.maxReconnectDelay = parseInt(config.maxReconnectDelay || 120);
        // Remark: user name and password are stored in this.credentials

        var node = this;

        // All Onvif nodes can add a listener to track the 'onvif_status' events.
        // However by default only 10 listeners are allowed, which results in a warning when more Onvif nodes use this config node:
        // MaxListenersExceededWarning: Possible EventEmitter memory leak detected
        // To avoid that, we will allow an infinite number of listeners.
        // Caution: when you have suspicion that the listeners are leaking, put the next line in comment !!!
        node.setMaxListeners(0);

        // ----------------------------------------------------------------
        // Internal helpers
        // ----------------------------------------------------------------

        /**
         * Build the options object used to create an onvif.Cam instance.
         */
        function buildCamOptions() {
            var options = {
                hostname: node.xaddress,
                port: node.port,
                timeout: node.timeout * 1000,
                agent: keepAliveAgent
            };
            if (node.credentials && node.credentials.user) {
                options.username = node.credentials.user;
                options.password = node.credentials.password;
            }
            return options;
        }

        /**
         * Stop all timers managed by this config node.
         */
        function clearAllTimers() {
            if (node.checkConnectionTimer) {
                clearInterval(node.checkConnectionTimer);
                node.checkConnectionTimer = null;
            }
            if (node.reconnectTimer) {
                clearTimeout(node.reconnectTimer);
                node.reconnectTimer = null;
            }
        }

        /**
         * Schedule a reconnection attempt using exponential backoff with jitter.
         *
         * Jitter (±20 % of the delay) is added so that, when all 30 cameras in
         * the warehouse drop simultaneously (e.g. switch reboot), their reconnect
         * attempts are naturally staggered instead of thundering all at once.
         *
         * @param {number} attempt - zero-based attempt counter (used to compute backoff)
         */
        function scheduleReconnect(attempt) {
            if (node.closing) return; // node is being shut down

            clearAllTimers();

            var baseDelay = node.reconnectDelay * 1000;          // ms
            var maxDelay = node.maxReconnectDelay * 1000;        // ms
            var backoff = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            // ±20 % jitter
            var jitter = (Math.random() * 0.4 - 0.2) * backoff;
            var delay = Math.max(1000, Math.round(backoff + jitter));  // at least 1 s

            node.warn("Scheduling reconnect attempt " + (attempt + 1) +
                " for camera " + node.xaddress + " in " + Math.round(delay / 1000) + "s");

            node.reconnectTimer = setTimeout(function () {
                if (node.closing) return;
                attemptConnect(attempt);
            }, delay);
        }

        /**
         * Create a fresh onvif.Cam instance and connect to the camera.
         * On success: start the health-check interval.
         * On failure: schedule the next backoff attempt.
         *
         * A *new* Cam object is always created (not reused) to ensure any stale
         * TCP sockets from the previous connection are discarded — this mirrors
         * the Shinobi NVR approach in createOnvifDevice().
         *
         * @param {number} attempt - zero-based attempt counter for backoff calculation
         */
        function attemptConnect(attempt) {
            if (node.closing) return;

            // Discard the old cam object so its TCP socket is released.
            node.cam = null;

            setOnvifStatus(node, "reconnecting");

            var options = buildCamOptions();

            node.cam = new onvif.Cam(options, function (err) {
                if (node.closing) return;

                if (err) {
                    // Connection failed — keep retrying with backoff
                    node.error("Cannot connect to " + node.xaddress + ": " + err);
                    setOnvifStatus(node, "disconnected");
                    scheduleReconnect(attempt + 1);
                } else {
                    // Verify capabilities were actually loaded — on Tapo cameras the
                    // TCP connection can be closed mid-handshake, causing the callback
                    // to fire without error but with no capabilities populated.
                    if (!node.cam.capabilities && !node.cam.services) {
                        node.error("Connected but no capabilities loaded (socket dropped mid-handshake): " + node.xaddress);
                        setOnvifStatus(node, "disconnected");
                        scheduleReconnect(attempt + 1);
                        return;
                    }
                    // Successfully connected
                    node.reconnectAttempts = 0;
                    setOnvifStatus(node, "connected");
                    startHealthCheck();
                }
            });
        }

        /**
         * Start the periodic health-check interval.
         *
         * The health check calls getSystemDateAndTime() which is a lightweight
         * SOAP request. If it fails:
         *   - Stop the health-check interval.
         *   - Emit "disconnected".
         *   - Kick off the exponential-backoff reconnect loop.
         *
         * If it succeeds but the Cam hasn't loaded its capabilities yet (camera
         * was unavailable at startup), call cam.connect() to fill them in.
         */
        function startHealthCheck() {
            clearAllTimers();

            if (node.checkConnectionInterval <= 0) return;

            node.checkConnectionTimer = setInterval(function () {
                if (!node.cam || node.closing) return;

                node.cam.getSystemDateAndTime(function (err) {
                    if (node.closing) return;

                    if (err) {
                        // Camera dropped — stop health check and start reconnect loop
                        clearAllTimers();
                        setOnvifStatus(node, "disconnected");
                        scheduleReconnect(0);
                    } else {
                        if (!node.cam.capabilities && !node.cam.services) {
                            // Camera responded to getSystemDateAndTime but capabilities
                            // were never loaded (e.g. constructor timed out midway).
                            // Calling cam.connect() here causes a second socket hang-up
                            // on Tapo cameras. Instead, do a clean full reconnect which
                            // creates a fresh Cam instance — the only reliable way to
                            // get capabilities on these cameras.
                            node.warn("Camera reachable but capabilities not loaded — doing full reconnect");
                            clearAllTimers();
                            setOnvifStatus(node, "disconnected");
                            scheduleReconnect(0);
                            return;
                        }
                        setOnvifStatus(node, "connected");
                    }
                });
            }, node.checkConnectionInterval * 1000);
        }

        // ----------------------------------------------------------------
        // Public API used by other nodes
        // ----------------------------------------------------------------

        this.getProfiles = function (clientConfig, response) {
            var profileNames = [];
            var cfg = {};

            // The client credentials will only contain the data (i.e. user name or password) which has changed.
            // The other data is not changed, so we will need use the original data stored on the server.
            clientConfig.username = clientConfig.user || this.credentials.user;
            clientConfig.password = clientConfig.password || this.credentials.password;

            // When the user appends some new text to the existing password, then the original password is passed via the client as __PWRD__
            // So replace __PWRD__ again by the original password.
            if (clientConfig.password && this.credentials.password) {
                clientConfig.password.replace('___PWRD__', this.credentials.password);
            }

            if (this.credentials.user !== clientConfig.user ||
                this.credentials.password !== clientConfig.password ||
                this.xaddress !== clientConfig.hostname) {
                var cam = new onvif.Cam(clientConfig, function (err) {
                    if (!err) {
                        if (cam.profiles) {
                            for (var i = 0; i < cam.profiles.length; i++) {
                                profileNames.push({
                                    label: cam.profiles[i].name,
                                    value: cam.profiles[i].$.token
                                });
                            }
                        }
                        response.json(profileNames);
                    }
                });
            } else {
                if (this.cam && this.cam.profiles) {
                    // The current deployed cam is still up-to-date, so let's use that one (for performance reasons)
                    for (var i = 0; i < this.cam.profiles.length; i++) {
                        profileNames.push({
                            label: this.cam.profiles[i].name,
                            value: this.cam.profiles[i].$.token
                        });
                    }
                }
                response.json(profileNames);
            }
        };

        this.getProfileTokenByName = function (profileName) {
            if (this.cam && this.cam.profiles) {
                // Try to find a profile with the specified name, and return the token
                for (var i = 0; i < this.cam.profiles.length; i++) {
                    if (this.cam.profiles[i].name === profileName) {
                        return this.cam.profiles[i].$.token;
                    }
                }
            }
            // No token found with the specified name
            return null;
        };

        // This should be called by all nodes that use this config node
        this.initialize = function () {
            // This config node can only be initialized once
            if (this.cam) {
                return;
            }

            // Without an xaddress, it is impossible to connect to an Onvif device
            if (!this.xaddress) {
                node.error("Cannot connect to unconfigured Onvif device", {});
                this.cam = null;
                setOnvifStatus(node, "unconfigured");
                return;
            }

            setOnvifStatus(node, "initializing");

            this.reconnectAttempts = 0;
            this.closing = false;

            // Perform the initial connection attempt (attempt index 0 → no backoff delay)
            var options = buildCamOptions();
            this.cam = new onvif.Cam(options, function (err) {
                if (node.closing) return;

                if (err) {
                    node.error("Cannot connect to " + node.xaddress + ": " + err);
                    setOnvifStatus(node, "disconnected");
                    // Start reconnect loop with initial backoff
                    scheduleReconnect(0);
                } else {
                    node.reconnectAttempts = 0;
                    setOnvifStatus(node, "connected");
                    startHealthCheck();
                }
            });
        };

        node.on('close', function () {
            node.closing = true;
            setOnvifStatus(node, "");
            node.removeAllListeners("onvif_status");
            clearAllTimers();
        });
    }

    RED.nodes.registerType("onvif-config", OnVifConfigNode, {
        credentials: {
            user: { type: "text" },
            password: { type: "password" }
        }
    });

    // Make all the available profiles accessible for the node's config screen
    RED.httpAdmin.get('/onvifdevice/:cmd/:config_node_id', RED.auth.needsPermission('onvifdevice.read'), function (req, res) {
        var configNode = RED.nodes.getNode(req.params.config_node_id);

        switch (req.params.cmd) {
            case "profiles":
                if (!configNode) {
                    console.log("Cannot determine profile list from node " + req.params.config_node_id);
                    return;
                }
                // Get the profiles of the camera, based on the config data on the client, instead of the config data
                // stored inside this config node.  Reason is that the config data on the client might be 'dirty', i.e. changed
                // by the user but not deployed yet on this config node.  But the client still needs to be able to get the profiles
                // corresponding to that dirty config node.  That way the config screen can be filled with profiles already...
                // But when the config data is not dirty, we will just use the profiles already loaded in this config node (which is faster).
                // See https://discourse.nodered.org/t/initializing-config-screen-based-on-new-config-node/7327/10?u=bartbutenaers
                configNode.getProfiles(req.query, res);
                break;
        }
    });
};
