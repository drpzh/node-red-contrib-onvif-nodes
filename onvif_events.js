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
 **/
module.exports = function (RED) {
    var settings = RED.settings;
    const onvif = require('onvif');
    const utils = require('./utils');

    function OnVifEventsNode(config) {
        RED.nodes.createNode(this, config);
        this.action = config.action;

        var node = this;

        // Retrieve the config node, where the device is configured
        node.deviceConfig = RED.nodes.getNode(config.deviceConfig);

        if (node.deviceConfig) {
            // Track whether the user has requested event listening.
            // This lets us auto-restart polling after a camera reconnects without
            // any manual intervention from the user.
            node.wasListening = false;

            node.listener = function (onvifStatus) {
                if (onvifStatus === "connected") {
                    // Camera just came (back) online.
                    if (node.wasListening && !node.subscription) {
                        // Auto-restart event polling after reconnection.
                        // Small delay to let the camera finish initialising before
                        // we create a new pull-point subscription.
                        node.warn("Camera reconnected — restarting event polling automatically");
                        node.status({ fill: "yellow", shape: "ring", text: "reconnecting events..." });

                        // Attempt to restart events, with retry if the event service
                        // isn't available yet (camera may still be initialising).
                        function tryStartEvents(attemptsLeft) {
                            if (node.stopPullingPermanent || node.subscription) return;
                            // Bail if the camera is no longer connected
                            if (!node.deviceConfig || node.deviceConfig.onvifStatus !== "connected") return;

                            if (!utils.hasService(node.deviceConfig.cam, 'event')) {
                                if (attemptsLeft > 0) {
                                    node.warn("Event service not ready yet — retrying in 5s (" + attemptsLeft + " attempts left)");
                                    setTimeout(function () { tryStartEvents(attemptsLeft - 1); }, 5000);
                                } else {
                                    node.warn("Camera does not support event service — giving up auto-restart");
                                    node.status({ fill: "red", shape: "ring", text: "no event service" });
                                }
                                return;
                            }

                            node.receive({ action: "start" });
                        }

                        setTimeout(function () { tryStartEvents(5); }, 5000);
                    } else if (!node.subscription) {
                        utils.setNodeStatus(node, 'event', onvifStatus);
                    }
                } else if (onvifStatus === "reconnecting") {
                    // Config node is currently trying to reconnect.
                    // Only update the visible status; don't tear down events yet
                    // (they may already be stopped from a prior disconnect).
                    if (!node.subscription) {
                        node.status({ fill: "yellow", shape: "ring", text: "camera reconnecting..." });
                    }
                } else {
                    // disconnected / initializing / unconfigured
                    if (!node.subscription) {
                        utils.setNodeStatus(node, 'event', onvifStatus);
                    }

                    if (node.subscription) {
                        // Camera dropped — stop pulling events
                        node.stopPulling = true;

                        if (node.renewalTimer) {
                            clearInterval(node.renewalTimer);
                            node.renewalTimer = null;
                        }

                        if (node.subscription.unsubscribe) {
                            node.subscription.unsubscribe(function (err) {
                                if (err) {
                                    console.log("Error unsubscribing on disconnect: " + err);
                                }
                            });
                        }
                        node.subscription = null;
                        node.processEventMessage = null;
                    }
                }
            };

            // Start listening for Onvif config nodes status changes
            node.deviceConfig.addListener("onvif_status", node.listener);

            // Show the current Onvif config node status already
            utils.setNodeStatus(node, 'event', node.deviceConfig.onvifStatus);

            node.deviceConfig.initialize();
        }

        node.on("input", function (msg) {
            var newMsg = {};

            // Note: the node's config screen has no 'action' input field yet ...
            var action = node.action || msg.action;

            if (!action) {
                // When no action specified in the node, it should be specified in the msg.action
                node.error("No action specified (in node or msg)");
                return;
            }

            // Don't perform these checks when e.g. the device is currently disconnected (because then e.g. no capabilities are loaded yet)
            if (action !== "reconnect") {
                if (!node.deviceConfig || node.deviceConfig.onvifStatus != "connected") {
                    node.error("This node is not connected to a device");
                    return;
                }

                if (!utils.hasService(node.deviceConfig.cam, 'event')) {
                    node.error("The device has no support for an event service");
                    return;
                }
            }

            // Seems that some Axis cams support pull point, although they return WSPullPointSupport 'false'
            /*if (!node.deviceConfig.cam.capabilities.events.WSPullPointSupport == true) {
                //console.warn('Ignoring input message since the device does not support pull point subscription');
                return;
            }*/

            newMsg.xaddr = this.deviceConfig.xaddress;
            newMsg.action = action;

            try {
                switch (action) {
                    case "start":
                        if (node.subscription) {
                            node.error("This node is already listening to device events");
                            return;
                        }
                        // Record that the user wants events — used for auto-restart on reconnect
                        node.wasListening = true;
                        node.stopPullingPermanent = false;

                        // define processor BEFORE any polling can happen
                        node.processEventMessage = function (camMessage) {
                            try {
                                if (!camMessage) return;

                                const topicRaw = (camMessage.topic && (camMessage.topic._ || camMessage.topic)) || "";
                                const eventTopic = (typeof topicRaw === "string")
                                    ? topicRaw.split("/").map(p => p.split(":").pop()).join("/")
                                    : topicRaw;

                                const mm = camMessage.message && camMessage.message.message;
                                if (!mm || !mm.$) return;

                                const out = {
                                    topic: eventTopic,
                                    time: mm.$.UtcTime,
                                    property: mm.$.PropertyOperation
                                };

                                if (mm.source && mm.source.simpleItem) {
                                    const s = Array.isArray(mm.source.simpleItem) ? mm.source.simpleItem[0] : mm.source.simpleItem;
                                    if (s && s.$) out.source = { name: s.$.Name, value: s.$.Value };
                                }
                                if (mm.key) out.key = mm.key;

                                if (mm.data && mm.data.simpleItem) {
                                    if (Array.isArray(mm.data.simpleItem)) {
                                        out.data = mm.data.simpleItem.map(x => x.$ ? ({ name: x.$.Name, value: x.$.Value }) : x);
                                    } else if (mm.data.simpleItem.$) {
                                        out.data = { name: mm.data.simpleItem.$.Name, value: mm.data.simpleItem.$.Value };
                                    }
                                } else if (mm.data && mm.data.elementItem) {
                                    out.data = { dataName: "elementItem", dataValue: JSON.stringify(mm.data.elementItem) };
                                }

                                node.send({ topic: out.topic, payload: out });

                            } catch (e) {
                                node.warn("processEventMessage error: " + e);
                            }
                        };

                        // Unsubscribe any stale server-side subscription before creating a new one.
                        // Tapo C100 firmware limits concurrent PullPoint subscriptions; if we
                        // don't explicitly unsubscribe, the camera rejects new ones with SOAP fault.
                        function doUnsubscribeThenCreate() {
                            const cam = node.deviceConfig.cam;
                            if (cam && cam.events && cam.events.subscription) {
                                try {
                                    cam.unsubscribe(function () {
                                        // ignore errors — stale sub may already be gone
                                        doCreateSubscription();
                                    });
                                } catch (e) {
                                    doCreateSubscription();
                                }
                            } else {
                                doCreateSubscription();
                            }
                        }

                        function doCreateSubscription() {
                        // create the PullPoint subscription
                        node.deviceConfig.cam.createPullPointSubscription(function (err, subscription, xml) {
                            if (err) {
                                node.error("Failed to create pull point subscription: " + err);
                                // Instead of silently giving up, schedule a retry with backoff
                                node.recreateAttempts = (node.recreateAttempts || 0) + 1;
                                const baseDelay = 5000; // 5s initial
                                const maxDelay = 60000; // 60s cap
                                const backoff = Math.min(baseDelay * Math.pow(2, node.recreateAttempts - 1), maxDelay);
                                const jitter = (Math.random() * 0.6 - 0.3) * backoff; // ±30%
                                const delay = Math.max(3000, Math.round(backoff + jitter));

                                if (node.recreateAttempts >= 10) {
                                    // After 10 consecutive failures, pause for 2 minutes
                                    node.warn("10 consecutive subscription creation failures — pausing 2 minutes");
                                    node.status({ fill: "red", shape: "ring", text: "subscription failed (cooling down)" });
                                    setTimeout(() => {
                                        if (node.stopPulling || node.stopPullingPermanent) return;
                                        node.recreateAttempts = 0;
                                        node.subscription = null;
                                        node.receive({ action: "start" });
                                    }, 120000);
                                } else {
                                    node.warn("Retrying subscription in " + Math.round(delay / 1000) + "s (attempt " + node.recreateAttempts + ")");
                                    node.status({ fill: "yellow", shape: "ring", text: "retry in " + Math.round(delay / 1000) + "s" });
                                    setTimeout(() => {
                                        if (node.stopPulling || node.stopPullingPermanent) return;
                                        node.subscription = null;
                                        node.receive({ action: "start" });
                                    }, delay);
                                }
                                return;
                            }

                            // Success — reset retry counter
                            node.recreateAttempts = 0;
                            // hangupCycleCount tracks consecutive create→hangup→recreate
                            // cycles. NOT reset here — only reset when a poll succeeds.
                            node.hangupCycleCount = node.hangupCycleCount || 0;

                            node.subscription = subscription;
                            node.stopPulling = false;
                            node.errorCount = 0;
                            node.hangupCount = 0; // separate counter for Tapo TCP hang ups
                            node.isPolling = false; // Track if poll is already running
                            node.recentEvents = new Map(); // For deduplication

                            // pick a working pull function (sub vs cam) for onvif@0.6.9 compatibility
                            const pullFn =
                                (subscription && typeof subscription.pullMessages === "function" && subscription.pullMessages.bind(subscription)) ||
                                (subscription && typeof subscription.PullMessages === "function" && subscription.PullMessages.bind(subscription)) ||
                                (node.deviceConfig.cam && typeof node.deviceConfig.cam.pullMessages === "function" && node.deviceConfig.cam.pullMessages.bind(node.deviceConfig.cam));

                            if (!pullFn) {
                                node.error("PullPoint has no pullMessages/PullMessages and cam has no pullMessages. Check onvif version.");
                                return;
                            }

                            // Set sync point if available (on sub or cam, varies by lib)
                            const setSync =
                                (subscription && typeof subscription.setSynchronizationPoint === "function" && subscription.setSynchronizationPoint.bind(subscription)) ||
                                (node.deviceConfig.cam && typeof node.deviceConfig.cam.setSynchronizationPoint === "function" && node.deviceConfig.cam.setSynchronizationPoint.bind(node.deviceConfig.cam));

                            if (setSync) {
                                try { setSync(() => { }); } catch (e) { /* ignore */ }
                            }

                            node.status({ fill: "green", shape: "dot", text: "listening (pull)" });
                            node.log("PullPoint ready — using " + (pullFn === node.deviceConfig.cam.pullMessages ? "cam.pullMessages" : "subscription.pullMessages"));

                            // Helper to recreate subscription with exponential backoff + jitter.
                            // After Tapo firmware updates, the camera needs time to release old
                            // subscriptions before accepting new ones.
                            function recreateSubscription(reason) {
                                node.recreateAttempts = (node.recreateAttempts || 0) + 1;
                                const baseDelay = 5000; // 5s initial
                                const maxDelay = 60000; // 60s cap
                                const backoff = Math.min(baseDelay * Math.pow(2, node.recreateAttempts - 1), maxDelay);
                                const jitter = (Math.random() * 0.6 - 0.3) * backoff; // ±30%
                                const delay = Math.max(3000, Math.round(backoff + jitter));

                                node.log("Recreating ONVIF subscription (attempt " + node.recreateAttempts + "): " + (reason || "expired or lost") + " — retry in " + Math.round(delay / 1000) + "s");
                                node.status({ fill: "yellow", shape: "ring", text: "recreating in " + Math.round(delay / 1000) + "s" });

                                // Stop polling
                                node.stopPulling = true;

                                // Clear old subscription on the camera side
                                if (node.subscription && node.subscription.unsubscribe) {
                                    try {
                                        node.subscription.unsubscribe(() => { });
                                    } catch (e) { /* ignore */ }
                                }
                                if (node.renewalTimer) {
                                    clearInterval(node.renewalTimer);
                                    node.renewalTimer = null;
                                }

                                // Also unsubscribe on the cam object to clear server-side state
                                const cam = node.deviceConfig && node.deviceConfig.cam;
                                if (cam && cam.events && cam.events.subscription) {
                                    try {
                                        cam.unsubscribe(function () { /* ignore */ });
                                    } catch (e) { /* ignore */ }
                                }

                                if (node.recreateAttempts >= 10) {
                                    // After 10 consecutive failures, pause for 2 minutes
                                    node.warn("10 consecutive recreation failures — cooling down 2 minutes");
                                    node.status({ fill: "red", shape: "ring", text: "cooling down (2 min)" });
                                    setTimeout(() => {
                                        if (node.stopPullingPermanent) return;
                                        node.recreateAttempts = 0;
                                        node.stopPulling = false;
                                        node.subscription = null;
                                        node.receive({ action: "start" });
                                    }, 120000);
                                    return;
                                }

                                setTimeout(() => {
                                    if (node.stopPullingPermanent) return;
                                    node.stopPulling = false;
                                    node.subscription = null;
                                    node.receive({ action: "start" });
                                }, delay);
                            }

                            // single poll loop with exponential backoff and subscription recreation
                            function poll() {
                                if (node.stopPulling || node.isPolling) return;
                                // Guard: don't poll if subscription was cleared (e.g. during recreate)
                                if (!node.subscription) return;
                                node.isPolling = true;

                                try {
                                pullFn({ timeout: "PT5S", messageLimit: 100 }, function (err, res) {
                                    node.isPolling = false;
                                    node.hangupCount = node.hangupCount || 0; // separate counter for TCP hang ups

                                    if (err) {
                                        // Check if this is a subscription/network error that requires recreation
                                        const errStr = (err.message || err.toString()).toLowerCase();
                                        const errCode = err.code || "";

                                        const isSubscriptionError =
                                            errStr.includes("subscription") ||
                                            errStr.includes("pullmessages") ||
                                            errStr.includes("invalid args") ||
                                            errStr.includes("not found") ||
                                            errStr.includes("terminated") ||
                                            errStr.includes("expired");

                                        if (isSubscriptionError) {
                                            node.warn("Subscription error detected: " + err);
                                            if (!node.stopPulling) {
                                                recreateSubscription("subscription error: " + err);
                                            }
                                            return;
                                        }

                                        // Socket hang up is NORMAL for Tapo cameras — they close the TCP
                                        // connection after serving each HTTP response (HTTP/1.1 keep-alive
                                        // is short on these cameras). This does NOT mean the ONVIF
                                        // subscription is expired; we just need to re-establish TCP.
                                        // We use a SEPARATE hangupCount so socket hang ups don't escalate
                                        // general errorCount and incorrectly trigger subscription recreation.
                                        const isSocketHangup =
                                            errStr.includes("socket hang up") ||
                                            errStr.includes("socket hang");

                                        if (isSocketHangup) {
                                            node.hangupCount++;
                                            // Socket hang ups are NORMAL for Tapo C100 — the camera
                                            // closes TCP after each response. The ONVIF subscription
                                            // is still valid on the camera side. Do NOT recreate —
                                            // just keep retrying. The poll will eventually succeed
                                            // when the camera is ready.
                                            if (node.hangupCount % 50 === 0) {
                                                node.log(node.hangupCount + " consecutive socket hang ups — still retrying");
                                            }
                                            // Retry poll after a short delay
                                            if (!node.stopPulling) setTimeout(poll, 1000);
                                            return;
                                        }

                                        // Track consecutive non-hangup errors
                                        node.errorCount = Math.min((node.errorCount || 0) + 1, 10);

                                        // Other network errors (connection refused, timeout, etc.)
                                        const isNetworkError =
                                            errStr.includes("econnreset") ||
                                            errStr.includes("etimedout") ||
                                            errStr.includes("econnrefused") ||
                                            errCode === "ECONNRESET" ||
                                            errCode === "ETIMEDOUT" ||
                                            errCode === "ECONNREFUSED";

                                        if (isNetworkError && node.errorCount >= 3) {
                                            node.log("Network error — recreating subscription");
                                            recreateSubscription("network error: " + err);
                                            return;
                                        }

                                        // General errors — exponential backoff
                                        const backoff = Math.min(1000 * Math.pow(2, node.errorCount - 1), 10000);
                                        node.warn("Poll error (attempt " + node.errorCount + "): " + err);
                                        if (!node.stopPulling) setTimeout(poll, backoff);
                                        return;
                                    }

                                    node.errorCount = 0;
                                    node.hangupCount = 0; // successful poll — reset hang up counter
                                    node.hangupCycleCount = 0; // successful data — reset cycle counter

                                    const list = res && res.notificationMessage
                                        ? (Array.isArray(res.notificationMessage) ? res.notificationMessage : [res.notificationMessage])
                                        : [];

                                    // Deduplicate events based on topic+time (C560 sends many duplicates)
                                    for (const n of list) {
                                        const camMessage = { topic: n.topic || n.Topic, message: n.message || n.Message };

                                        // Create unique key from topic and time
                                        const mm = camMessage.message && camMessage.message.message;
                                        if (mm && mm.$) {
                                            const eventKey = (n.topic || n.Topic) + '|' + mm.$.UtcTime;
                                            const now = Date.now();

                                            // Check if we've seen this event in last 2 seconds
                                            if (node.recentEvents.has(eventKey)) {
                                                const lastSeen = node.recentEvents.get(eventKey);
                                                if (now - lastSeen < 2000) {
                                                    continue; // Skip duplicate
                                                }
                                            }

                                            // Record this event
                                            node.recentEvents.set(eventKey, now);

                                            // Clean old entries (older than 5 seconds)
                                            for (const [key, timestamp] of node.recentEvents.entries()) {
                                                if (now - timestamp > 5000) {
                                                    node.recentEvents.delete(key);
                                                }
                                            }
                                        }

                                        if (node.processEventMessage) node.processEventMessage(camMessage);
                                    }

                                    if (!node.stopPulling) setTimeout(poll, 0);
                                });
                                } catch (e) {
                                    // Handle 'You should create pull-point subscription first!' errors
                                    // that occur when subscription is cleared during recreate
                                    node.isPolling = false;
                                    if (!node.stopPulling) {
                                        recreateSubscription("poll exception: " + e.message);
                                    }
                                }
                            }

                            // Subscription renewal timer — 45s interval.
                            // Tapo C100 doesn't support renewal; stop the timer on first failure
                            // to avoid unnecessary SOAP requests that waste camera resources.
                            if (subscription && typeof subscription.renew === "function") {
                                node.renewalTimer = setInterval(() => {
                                    if (!node.stopPulling && node.subscription) {
                                        subscription.renew((err) => {
                                            if (err) {
                                                node.log("Subscription renewal not supported — disabling renewal timer");
                                                if (node.renewalTimer) {
                                                    clearInterval(node.renewalTimer);
                                                    node.renewalTimer = null;
                                                }
                                            } else {
                                                node.log("Subscription renewed successfully");
                                            }
                                        });
                                    }
                                }, 45000);
                            } else {
                                node.log("Subscription does not support renewal — will recreate on expiry");
                            }

                            poll();
                        });
                        } // end doCreateSubscription

                        doUnsubscribeThenCreate();

                        break;
                    case "stop":
                        if (!node.subscription) {
                            node.error("This node was not listening to events anyway");
                            return;
                        }

                        // User explicitly stopped — don't auto-restart on reconnect
                        node.wasListening = false;
                        node.stopPullingPermanent = true;

                        // Stop the polling loop
                        node.stopPulling = true;

                        // Clear renewal timer
                        if (node.renewalTimer) {
                            clearInterval(node.renewalTimer);
                            node.renewalTimer = null;
                        }

                        // Unsubscribe from pull point
                        if (node.subscription && node.subscription.unsubscribe) {
                            node.subscription.unsubscribe(function (err) {
                                if (err) {
                                    console.log("Error unsubscribing: " + err);
                                }
                            });
                        }

                        node.subscription = null;
                        node.processEventMessage = null;

                        // Overwrite the device status text
                        node.status({ fill: "green", shape: "ring", text: "not listening" });
                        break;
                    case "getEventProperties":
                        node.deviceConfig.cam.getEventProperties(function (err, eventProperties, xml) {
                            if (!err) {
                                var simplifiedProperties = {};

                                // Simplify the soap message to a compact message, by keeping only all relevant information
                                function simplifyNode(treeNode, simplifiedChild) {
                                    // loop over all the child nodes in this node
                                    for (const child in treeNode) {
                                        switch (child) {
                                            case "$":
                                                // Continue to the next child in the list (same level)
                                                continue;
                                            case "messageDescription":
                                                // Collect the details that belong to the event
                                                if (treeNode[child].source && treeNode[child].source.simpleItemDescription) {
                                                    simplifiedChild.source = treeNode[child].source.simpleItemDescription.$;
                                                }
                                                if (treeNode[child].data && treeNode[child].data.simpleItemDescription) {
                                                    simplifiedChild.data = treeNode[child].data.simpleItemDescription.$;
                                                }

                                                return;
                                            default:
                                                // Descend recursively into the child node, looking for the messageDescription
                                                simplifiedChild[child] = {};
                                                simplifyNode(treeNode[child], simplifiedChild[child]);
                                        }
                                    }
                                }

                                if (eventProperties && eventProperties.topicSet) {
                                    simplifyNode(eventProperties.topicSet, simplifiedProperties);
                                }
                            }

                            utils.handleResult(node, err, simplifiedProperties, null, newMsg);
                        });
                        break;
                    case "getEventServiceCapabilities":
                        node.deviceConfig.cam.getEventServiceCapabilities(function (err, capabilities, xml) {
                            utils.handleResult(node, err, capabilities, xml, newMsg);
                        });
                        break;
                    case "reconnect":
                        node.deviceConfig.cam.connect(function (err) {
                            utils.handleResult(node, err, "", null, newMsg);
                        });
                        break
                    default:
                        //node.status({fill:"red",shape:"dot",text: "unsupported action"});
                        node.error("Action " + action + " is not supported");
                }
            }
            catch (exc) {
                node.error("Action " + action + " failed: " + exc);
            }
        });

        node.on("close", function () {
            if (node.listener) {
                node.deviceConfig.removeListener("onvif_status", node.listener);
            }

            // Stop the polling loop
            node.stopPulling = true;

            // Clear renewal timer
            if (node.renewalTimer) {
                clearInterval(node.renewalTimer);
                node.renewalTimer = null;
            }

            // Unsubscribe from pull point
            if (node.subscription && node.subscription.unsubscribe) {
                node.subscription.unsubscribe(function (err) {
                    if (err) {
                        console.log("Error unsubscribing on close: " + err);
                    }
                });
            }

            node.subscription = null;
            node.processEventMessage = null;
        });
    }
    RED.nodes.registerType("onvif-events", OnVifEventsNode);
}
