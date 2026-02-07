// ==UserScript==
// @name                WME Color Highlights
// @namespace           http://userscripts.org/users/419370
// @description         Adds colours to road segments to show their status
// @include             https://www.waze.com/*/editor*
// @include             https://www.waze.com/editor*
// @include             https://beta.waze.com/*
// @exclude             https://www.waze.com/*user/*editor/*
// @grant               none
// @downloadURL         https://update.greasyfork.org/scripts/3206/WME%20Color%20Highlights.user.js
// @updateURL           https://update.greasyfork.org/scripts/3206/WME%20Color%20Highlights.meta.js
// @version             3.03
// ==/UserScript==

const wmech_version = "3.03";

let wmeSDK;
const PERMANENT_HAZARDS_HIGHLIGHTING_LAYER = 'color_highlights_permanent_hazards';
window.SDK_INITIALIZED.then(() => {
    wmeSDK = getWmeSdk({scriptId: "wme-color-highlights", scriptName: "WME Color Highlights"});
    wmeSDK.Events.once({eventName: "wme-ready"}).then(initialiseHighlights);
});

function catchError(fn, errorsToCatch = []) {
    try {
        return [null, fn()];
    } catch (e) {
        if (!errorsToCatch || errorsToCatch.length === 0 || errorsToCatch.some(error => e instanceof error)) {
            return [e, null];
        }
        throw e;
    }
}

function trackDataModelEvents(dataModelName, featureMapper, {
    added,
    changed,
    deleted,
    removed,
    saved,
}) {
    const createHandler = (handler) => {
        return ({ dataModelName: eventDataModelName, ...args }) => {
            if (dataModelName !== eventDataModelName) return;
            handler(args);
        }
    };

    let hasSubscribedEvents = false;
    if (added || removed) {
        hasSubscribedEvents = true;
        wmeSDK.Events.on({
            eventName: 'wme-data-model-object-changed-id',
            eventHandler: createHandler(({ objectIds }) => {
                if (removed) removed(objectIds.oldID);
                if (added) added(featureMapper(objectIds.newID));
            }),
        });
    }
    if (added) {
        hasSubscribedEvents = true;
        wmeSDK.Events.on({
            eventName: 'wme-data-model-objects-added',
            eventHandler: createHandler(({ objectIds }) => {
                objectIds.forEach((id) => added(featureMapper(id)));
            }),
        });
    }
    if (changed) {
        hasSubscribedEvents = true;
        wmeSDK.Events.on({
            eventName: 'wme-data-model-objects-changed',
            eventHandler: createHandler(({ objectIds }) => {
                objectIds.forEach((id) => changed(featureMapper(id)));
            }),
        });
    }
    if (deleted) {
        hasSubscribedEvents = true;
        wmeSDK.Events.on({
            eventName: 'wme-data-model-object-state-deleted',
            eventHandler: createHandler(({ objectIds }) => {
                objectIds.forEach((id) => deleted(featureMapper(id)));
            }),
        });
    }
    if (saved) {
        hasSubscribedEvents = true;
        wmeSDK.Events.on({
            eventName: 'wme-data-model-objects-saved',
            eventHandler: createHandler(({ objectIds }) => {
                objectIds.forEach((id) => saved(featureMapper(id)));
            }),
        });
    }
    if (removed) {
        hasSubscribedEvents = true;
        wmeSDK.Events.on({
            eventName: 'wme-data-model-objects-removed',
            eventHandler: createHandler(({ objectIds }) => {
                objectIds.forEach((id) => removed(id));
            }),
        });
    }

    if (hasSubscribedEvents) {
        const [validationError] = catchError(() => wmeSDK.Events.trackDataModelEvents({ dataModelName }), [wmeSDK.Errors.ValidationError]);
        if (validationError) {
            // ideally, the WME SDK should not throw ValidationError here, but if it does,
            // then we're dealing with a data model that does not support native event tracking through the SDK
            // which is a shame, due to how generic the data model event tracking mechanism is
            // so we'll have to resort to manually hooking the underlying WME events and match the SDK safety guards

            if (wmeSDK.Events.trackedDataModels.has(dataModelName)) return;

            const repo = W.model.getRepositoryByName(dataModelName);
            if (!repo)
                throw new Error(`Data model repository not found: ${dataModelName}`);
            
            const eventsToSubscribe = {
                objectsadded: (features) => {
                    wmeSDK.Events.eventBus.trigger('wme-data-model-objects-added', {
                        dataModelName,
                        objectIds: features.map((f) => f.getID()).filter((id) => id != null),
                    });
                },
                objectschanged: (features) => {
                    wmeSDK.Events.eventBus.trigger('wme-data-model-objects-changed', {
                        dataModelName,
                        objectIds: features.map((f) => f.getID()).filter((id) => id != null),
                    });
                },
                'objectschanged-id': (objectIds) => {
                    wmeSDK.Events.eventBus.trigger('wme-data-model-object-changed-id', {
                        dataModelName,
                        objectIds,
                    });
                },
                objectsremoved: (features) => {
                    wmeSDK.Events.eventBus.trigger('wme-data-model-objects-removed', {
                        dataModelName,
                        objectIds: features.map((f) => f.getID()).filter((id) => id != null),
                    });
                },
                'objects-state-deleted': (features) => {
                    wmeSDK.Events.eventBus.trigger('wme-data-model-object-state-deleted', {
                        dataModelName,
                        objectIds: features.map((f) => f.getID()).filter((id) => id != null),
                    });
                },
                'objectssynced': (features) => {
                    wmeSDK.Events.eventBus.trigger('wme-data-model-objects-saved', {
                        dataModelName,
                        objectIds: features.map((f) => f.getID()).filter((id) => id != null),
                    });
                },
            };
            Object.entries(eventsToSubscribe).forEach(([eventName, handler]) => {
                repo.on(eventName, handler);
            });
            wmeSDK.Events.trackedDataModels.set(dataModelName, { events: eventsToSubscribe });
        }
    }
}

/**
 * Get the display geometry for a feature by searching through the provided layers.
 * Can be used to get the geometry as rendered on the map, which may differ from the data model geometry.
 * @param {number|string} objectId The object ID of the feature
 * @param {OpenLayers.Layer[]} sourceLayers The layers to search through
 * @returns {object} The GeoJSON geometry of the feature as it is rendered on the map (not necessarily the same as the data model geometry)
 * @throws {Error} If the feature is not found in any of the provided layers
 */
function getFeatureDisplayGeometry(objectId, sourceLayers = W.map.layers) {
    for (const layer of sourceLayers) {
        if (!layer.featureMap) continue;
        if (!layer.featureMap.has(objectId)) continue;
        const feature = layer.featureMap.get(objectId);
        const openLayersGeometry = feature.geometry;
        return W.userscripts.toGeoJSONGeometry(openLayersGeometry);
    }

    throw new Error(`Feature geometry not found: ${objectId}`);
}

function initPermanentHazardsLayer() {
    const permanentHazardLayers = W.map.layers.filter(
        (layer) => layer.name.includes('permanent_hazard') &&
                    !layer.name.includes('markers')
    );

    const [addLayerFailed] = catchError(() => {
        wmeSDK.Map.addLayer({
            layerName: PERMANENT_HAZARDS_HIGHLIGHTING_LAYER,
            styleRules: [
                {
                    style: {
                        pointRadius: 20,
                        fillColor: 'transparent',
                        fillOpacity: 0.4,
                        stroke: false,
                    },
                },
            ],
        });
    }, [wmeSDK.Errors.InvalidStateError]);
    if (addLayerFailed) return;

    const addPermanentHazard = (hazard) => {
        if (!hazard) throw new Error('Permanent hazard is undefined');

        wmeSDK.Map.addFeatureToLayer({
            layerName: PERMANENT_HAZARDS_HIGHLIGHTING_LAYER,
            feature: {
                type: 'Feature',
                id: hazard.getID(),
                geometry: getFeatureDisplayGeometry(hazard.getID(), permanentHazardLayers),
                properties: {
                    wazeFeature: hazard,
                },
            }
        });
    };
    const removePermanentHazard = (hazardId) => {
        wmeSDK.Map.removeFeatureFromLayer({
            layerName: PERMANENT_HAZARDS_HIGHLIGHTING_LAYER,
            featureId: hazardId,
        });
    };

    trackDataModelEvents('permanentHazards', (id) => W.model.permanentHazards.objects[id], {
        added: (hazard) => addPermanentHazard(hazard),
        removed: (hazardId) => removePermanentHazard(hazardId),
        deleted: (hazard) => removePermanentHazard(hazard.getID()),
        changed: (hazard) => {
            removePermanentHazard(hazard.getID());
            addPermanentHazard(hazard);
        },
    });
}

// global variables
const NOT_THIS_USER = 'NOT_THIS_USER';

const advancedMode = false;
const lastModified = false;
const selectedLines = [];
let venueMainCategories = [];

function highlightSegments(event) {

    const showLocked = getId('_cbHighlightLocked').checked;
    const showToll = getId('_cbHighlightToll').checked;
    const showNoCity = getId('_cbHighlightNoCity').checked;
    const showAltName = getId('_cbHighlightAltName').checked;
    const showNoName = getId('_cbHighlightUnnamed').checked;
    const showOneWay = getId('_cbHighlightOneWay').checked;
    const showRestrictions = getId('_cbHighlightRestrictions').checked;
    const showSpeedLimits = getId('_cbHighlightSpeedLimits').checked;
    const showAvgSpeedCams = getId('_cbHighlightAvgSpeedCams').checked;
    const showLanes = getId('_cbHighlightLanes').checked;
    const plusRamps = getId('_cbHighlightPlusRampLimits').checked;
    const plusStreets = getId('_cbHighlightPlusStreetLimits').checked;
    let specificCity = getId('_cbHighlightCity').checked;
    const specificCityInvert = getId('_cbHighlightCityInvert').checked;
    const specificRoadType = getId('_cbHighlightRoadType').checked;
    const showNoHNs = getId('_cbHighlightNoHN').checked;
    const showRoutingPref = getId('_cbHighlightRoutingPref').checked;

    const showRecent = getId('_cbHighlightRecent').checked;
    let specificEditor = getId('_cbHighlightEditor').checked;

    // master switch when all options are off
    if (!(showLocked || showToll || showNoCity || showNoName || showAltName || showOneWay || showRestrictions
          || specificCity || specificEditor || specificRoadType || showRecent || showSpeedLimits || showAvgSpeedCams
          || showLanes || showNoHNs)) {
        if (event?.type == 'click') {
            for (var segment of wmeSDK.DataModel.Segments.getAll()) {
                var line = wmeSDK.Map.getFeatureDomElement({featureId: segment.id, layerName: "segments"});

                if (line === null) {
                    continue;
                }

                // turn off all highlights
                var opacity = line.getAttribute("stroke-opacity");
                if (opacity > 0.1 && opacity < 1) {
                    line.setAttribute("stroke", "#dd7700");
                    line.setAttribute("stroke-opacity", 0.001);
                    line.setAttribute("stroke-dasharray", "none");
                }
            }
        }
        return;
    }

    const today = new Date();
    let recentDays;
    let selectedUserId = null;
    let selectedCityId = null;
    if (specificEditor) {
        const selectUser = getId('_selectUser');
        if (selectUser.selectedIndex >= 0)
            selectedUserId = selectUser.options[selectUser.selectedIndex].value;
        else
            specificEditor = false;
    }

    if (specificCity) {
        const selectCity = getId('_selectCity');
        if (selectCity.selectedIndex >= 0)
            selectedCityId = selectCity.options[selectCity.selectedIndex].value;
        else
            specificCity = false;
    }

    if (specificRoadType) {
        var selectedRoadType;
        const selectRoadType = getId('_selectRoadType');
        if (selectRoadType.selectedIndex >= 0)
            selectedRoadType = selectRoadType.options[selectRoadType.selectedIndex].value;
    }

    if (showRecent) {
        recentDays = getId('_numRecentDays').value;
        if (recentDays === undefined) recentDays = 0;
    }

    // counters
    let numUserHighlighted = 0;
    let numCityHighlighted = 0;
    let streetData = wmeSDK.DataModel.Streets.getAll();
    let cityData = wmeSDK.DataModel.Cities.getAll();

    for (segment of wmeSDK.DataModel.Segments.getAll()) {
        line = wmeSDK.Map.getFeatureDomElement({featureId: segment.id, layerName: "segments"});

        if (line === null) {
            continue;
        }

        // check that WME hasn't highlighted this segment
        opacity = line.getAttribute("stroke-opacity");
        const lineWidth = line.getAttribute("stroke-width");
        if (opacity == 1 || lineWidth == 9)
            continue;

        // turn off highlights when roads are no longer visible
        const roadType = segment.roadType;
        if (wmeSDK.Map.getZoomLevel() <= 3 && (roadType < 2 || roadType > 7)) {
            if (opacity > 0.1) {
                line.setAttribute("stroke", "#dd7700");
                line.setAttribute("stroke-opacity", 0.001);
                line.setAttribute("stroke-dasharray", "none");
            }
            continue;
        }

        const sid = segment.primaryStreetId;
        // highlight all newly paved roads (or roads without any nodes)
        if (sid === null || (segment.toNodeId === null && segment.fromNodeId === null && roadType < 9)) {
            if (opacity < 0.1 && showNoName) {
                line.setAttribute("stroke", "#f00");
                line.setAttribute("stroke-opacity", 0.75);
                line.setAttribute("stroke-width", 10);
            }
            continue;
        }

        // get attributes for this segment
        const locked = segment.lockRank > 0;

        const street = streetData.find(({ id }) => id === segment.primaryStreetId);
        const noName = street?.isEmpty;
        const cityID = street.cityId;
        const city = cityData.find(({ id }) => id === cityID);
        const noCity = !!city?.isEmpty;

        const oneWay = !segment.isTwoWay;
        const hasRestrictions = segment.hasRestrictions;
        const updatedBy = segment.modificationData.updatedBy;
        const isRoundabout = !!segment.junctionId;
        const hasHouseNumbers = segment.hasHouseNumbers;

        // get current state of the line
        const lineColor = line.getAttribute("stroke");

        // default colours
        let newColor = "#dd7700";
        let newOpacity = 0.001;
        let newDashes = "none";
        let newWidth = 6;

        // Recent Edits within X days, with decaying green opacity
        if (showRecent) {
            let editDays = (today.getTime() - segment.modificationData.createdOn) / 86400000;
            if (segment.modificationData.updatedOn !== null) {
                editDays = (today.getTime() - segment.modificationData.updatedOn) / 86400000;
            }
            if (recentDays >= 0 && editDays <= recentDays) {
                if ((updatedBy == selectedUserId) || (!specificEditor)) {
                    //var heatScale = 0.75 / recentDays;
                    //newColor = "#0f0";
                    const shade = Math.floor(editDays * 128 / recentDays);
                    newColor = "rgb(" + (0) + ", " + (255 - shade) + ", " + (0) + ")";
                    newOpacity = 0.5;
                    //newOpacity = Math.min(0.999999, 1 - (editDays * heatScale));
                }
            }
        }

        // Toll = Dashed
        else if (showToll && isTollSegment(segment.id)) {
            newColor = "#00f";
            newOpacity = 0.5;
            newDashes = "10 10";
        }

        // No Edit = Black
        else if (showLocked && !canEdit(segment.id)) {
            newColor = "#000";
            newOpacity = 0.75;
            newWidth = 3;
        }

        // Locked = Red
        else if (locked && showLocked) {
            newColor = "#f00";
            newWidth = 6;
            newOpacity = 0.2 * Math.min(5, segment.lockRank);
        }

        else if (hasRestrictions && showRestrictions) {
            newColor = "#909";
            newDashes = "10 10";
            newOpacity = 0.5;
        }

        // alternate names
        else if (showAltName && segment.alternateStreetIds.length > 0) {
            newColor = "#9C0";
            newOpacity = 0.75;
            if (noName) {
                newDashes = "10 10";
            }
        }

        // No Speed Limits = Orange
        else if (showSpeedLimits && (plusStreets && segment.roadType == 1 || plusRamps && segment.roadType == 4 || segment.roadType > 1 && segment.roadType != 4)
            && segment.roadType < 8 && segment.roadType != 5
            && (plusStreets || segment.junctionId == null)
            && (
                ((segment.isAtoB || segment.isTwoWay) && (segment.fwdSpeedLimit == null || !segment.isFwdSpeedLimitVerified)) ||
                ((segment.isBtoA || segment.isTwoWay) && (segment.revSpeedLimit == null || !segment.isRevSpeedLimitVerified)))
            ) {
            newColor = "#f80";
            newOpacity = 0.8;
            newWidth = 4;
        }

        // Average Speed Cameras = Blue
        else if (showAvgSpeedCams && (segment.flagAttributes.fwdSpeedCamera || segment.flagAttributes.revSpeedCamera)) {
            newColor = "#00f";
            newOpacity = 0.4;
            newWidth = 4;
        }

        // Lane guidance = Cyan
        else if (showLanes && (segment.flagAttributes.fwdLanesEnabled || segment.flagAttributes.revLanesEnabled)) {
            newColor = "#088";
            newOpacity = 0.8;
            newWidth = 4;
            newDashes = "2 8";
        }

        // Unnamed (No Name) = Orange
        // except roundabouts and non-Streets
        else if (noName && showNoName && !isRoundabout && segment.roadType < 8) {
            newColor = "#fb0";
            newOpacity = 0.6;
        }

        // No City = Gray
        else if (noCity && showNoCity) {
            newColor = "#888";
            newOpacity = 0.5;
        }

        // One Way = Blue
        else if (oneWay && showOneWay) {
            newColor = "#00f";
            newOpacity = 0.4;
            newWidth = 4;
        }
        // segment with special flags
        else if (specificRoadType && (selectedRoadType >= 64 && selectedRoadType < 98)) {
            // - any flags
            if (selectedRoadType == 64 && Object.values(segment.flagAttributes).some(value => value === true)) {
                newColor = "#909";
                newOpacity = 0.5;
                newWidth = 4;
            }
            // - tunnel
            else if (selectedRoadType == 65 && segment.flagAttributes.tunnel) {
                newColor = "#909";
                newOpacity = 0.5;
                newWidth = 4;
            }
            // - tunnel and elevation
            else if (selectedRoadType == 66 && segment.flagAttributes.tunnel && segment.elevationLevel != 0) {
                newColor = "teal";
                // Railway tunnels
                newOpacity = (segment.roadType == 18) ? 0.4 : 0.8;

                switch (segment.elevationLevel) {
                    case -1:
                        newColor = "green";
                        break;
                    case -2:
                        newColor = "blue";
                        break;
                    case -3:
                        newColor = "purple";
                        break;
                    case -4:
                        newColor = "red";
                        break;
                    case -5:
                        newColor = "darkblue";
                        break;
                    case -6:
                        newColor = "black";
                        break;
                    case -7:
                        newColor = "darkblue";
                        newDashes = "6 10";
                        break;
                    case -8:
                        newColor = "black";
                        newDashes = "6 10";
                }
            }
            // - unpaved
            else if (selectedRoadType == 67 && segment.flagAttributes.unpaved) {
                newColor = "#900";
                newOpacity = 0.5;
                newWidth = 4;
            }
            // - headlights required
            else if (selectedRoadType == 68 && segment.flagAttributes.headlights) {
                newColor = "#909";
                newOpacity = 0.5;
                newWidth = 4;
            }
            // - beacons
            else if (selectedRoadType == 69 && segment.flagAttributes.beacons) {
                newColor = "#909";
                newOpacity = 0.5;
                newWidth = 4;
            }
            // - nearbyHOV
            else if (selectedRoadType == 70 && segment.flagAttributes.nearbyHOV) {
                newColor = "#909";
                newOpacity = 0.5;
                newWidth = 4;
            }
        }

        // selected road type = purple
        else if (specificRoadType && segment.roadType == selectedRoadType) {
            newColor = "#909";
            newOpacity = 0.5;
            newWidth = 4;
        }

        // special road types: non-drivable / non-routable
        else if (specificRoadType && selectedRoadType == 98 && nonRoutableTypes.includes(segment.roadType)) {
            newColor = "#909";
            newOpacity = 0.5;
            newWidth = 4;
        }
        else if (specificRoadType && selectedRoadType == 99 && nonDrivableTypes.includes(segment.roadType)) {
            newColor = "#909";
            newOpacity = 0.5;
            newWidth = 4;
        }

        // highlight roads with a routing preferrence set
        else if (showRoutingPref && segment.routingRoadType != null) {
            switch (segment.routingRoadType) {
                case 1: // St
                    newColor = "#ffffeb";
                    break;
                case 2: // PS
                    newColor = "#f0ea58";
                    break;
                case 3: // FW
                    newColor = "#c577d2";
                    break;
                case 6: // MH
                    newColor = "#45b8d1";
                    break;
                case 7: // mH
                    newColor = "#69bf88";
            }
            newOpacity = 0.5;
            newWidth = 6;
        }

        // highlight roads with no house numbers (except Roundabouts, Freeways, Ramps and Walking Trails)
        else if (!hasHouseNumbers && showNoHNs && segment.junctionId == null && segment.roadType < 8 && (segment.roadType < 3 || segment.roadType > 5)) {
            newColor = "#800000";
            newOpacity = 0.5;
            newDashes = "10 10";
        }

        // highlight segments by selected user, unless already highlighted
        if (specificEditor && !showRecent) {
            if (updatedBy == selectedUserId && newColor == "#dd7700") {
                newColor = "#00ff00";
                newOpacity = 0.5;
                numUserHighlighted++;
            }
            else if (selectedUserId === NOT_THIS_USER && updatedBy != wmeSDK.State.getUserInfo().userName && newColor == "#dd7700") {
                newColor = "#00ff00";
                newOpacity = 0.5;
                numUserHighlighted++;
            }
            else if (updatedBy != selectedUserId) {
                newColor = "#dd7700";
                newOpacity = 0.001;
                newDashes = "none";
            }
        }

        // highlight segments by selected City, unless already highlighted
        // if city is only on an alternate street highlight it with dashes
        if (specificCity) {
            let altCityMatch = false;
            let specificCityMatch = (cityID == selectedCityId);
            if (specificCityInvert)
                specificCityMatch = (cityID != selectedCityId && !noCity);
            if (!specificCityMatch) {
                // look for matching city in alternate streets
                for (let streetId of segment.alternateStreetIds) {
                    const currentStreet = streetData.find(({ id }) => id === streetId);
                    if (currentStreet == null)
                        continue;
                    let cityMatch = (currentStreet.cityId == selectedCityId);
                    if (specificCityInvert)
                        cityMatch = !cityMatch
                    if (cityMatch) {
                        altCityMatch = true;
                        break;
                    }
                }
            }

            if (specificCityMatch && (newColor == "#dd7700" || newColor == "#888")) {
                newColor = "#ed28ea";
                newOpacity = 0.5;
                newDashes = "none";
                numCityHighlighted++;
            }
            else if (altCityMatch && (newColor == "#dd7700" || newColor == "#888")) {
                newColor = "#ed28eb";
                newOpacity = 0.5;
                newDashes = "10 10";
                newWidth = 6;
                numCityHighlighted++;
            }
            else if (!specificCityMatch && !altCityMatch && !noCity) {
                newColor = "#dd7700";
                newOpacity = 0.001;
                newDashes = "none";
            }
        }

        // if colour has changed, update the line attributes
        if (lineColor != newColor) {
            line.setAttribute("stroke", newColor);
            line.setAttribute("stroke-opacity", newOpacity);
            line.setAttribute("stroke-dasharray", newDashes);
            if (newColor != "#dd7700") { //default
                line.setAttribute("stroke-width", newWidth);
            }
            else {
                line.setAttribute("stroke-width", 6);
            }
        }
    } // end of loop

    const numUserHighlightedText = getId('_numUserHighlighted');
    if (specificEditor)
        numUserHighlightedText.innerHTML = ' = ' + numUserHighlighted;
    else
        numUserHighlightedText.innerHTML = '';

    const numCityHighlightedText = getId('_numCityHighlighted');
    if (specificCity)
        numCityHighlightedText.innerHTML = ' = ' + numCityHighlighted;
    else
        numCityHighlightedText.innerHTML = '';
} // end of function

function isTollSegment(segmentId) {
    return wmeSDK.DataModel.Segments.isTollSegment({segmentId: segmentId});
}

function canEdit(segmentId) {
    return wmeSDK.DataModel.Segments.hasPermissions({segmentId: segmentId});
}

function highlightPlaces(event) {
    const venues = wmeSDK.DataModel.Venues.getAll();
    if (venues.isEmpty) {
        return;
    }

    // refreshing, reset places to original style
    if (event?.type && /click|change/.test(event.type)) {
        for (var venue of venues) {
            var poly = wmeSDK.Map.getFeatureDomElement({featureId: venue.id, layerName: "venues"});

            if (poly !== null && poly.getAttribute("stroke-opacity") == 0.987) {
                if (venue.geometry.type === "Point") {
                    poly.setAttribute("stroke", "white");
                }
                else {
                    poly.setAttribute("stroke", "#ca9ace");
                    poly.setAttribute("stroke-width", 2);
                    poly.setAttribute("stroke-dash-array", "none");
                }
                poly.setAttribute("fill", "#c290c6");
                poly.setAttribute("stroke-opacity", 1)
            }
        }
    }

    // if option is disabled, stop now
    if (!getId('_cbHighlightPlaces').checked) {
        if (event?.type == 'click') {
            getId('_cbHighlightLockedPlaces').disabled = true;
            getId('_cbHighlightIncompletePlaces').disabled = true;
        }
        return;
    }
    else {
        if (event?.type == 'click') {
            getId('_cbHighlightLockedPlaces').disabled = false;
            getId('_cbHighlightIncompletePlaces').disabled = false;
        }
    }

    const showLocked = getId('_cbHighlightLockedPlaces').checked;
    const showIncomplete = getId('_cbHighlightIncompletePlaces').checked;
    let specificCity = getId('_cbHighlightCity').checked;
    const specificCityInvert = getId('_cbHighlightCityInvert').checked;
    let showRecent = getId('_cbHighlightRecent').checked;

    if (specificCity) {
        const selectCity = getId('_selectCity');
        var selectedCityId;
        if (selectCity.selectedIndex >= 0) {
            selectedCityId = selectCity.options[selectCity.selectedIndex].value;
        }
        else {
            specificCity = false;
        }
    }

    let specificEditor = getId('_cbHighlightEditor').checked;

    if (specificEditor) {
        const selectEditor = getId('_selectUser');
        var selectedEditorId;
        if (selectEditor.selectedIndex >= 0) {
            selectedEditorId = selectEditor.options[selectEditor.selectedIndex].value;
        }
        else {
            specificEditor = false;
        }
    }

    if (showRecent) {
        var recentDays = getId('_numRecentDays').value;
        if (recentDays === undefined) recentDays = 0;
        if (recentDays == 0) showRecent = false;
    }

    let updates = 0;
    let streetData = wmeSDK.DataModel.Streets.getAll();
    for (venue of venues) {
        poly = wmeSDK.Map.getFeatureDomElement({featureId: venue.id, layerName: "venues"});
        // check that WME hasn't highlighted this object already
        if (poly == null || venue.state == "Update" || venue.selected) {
            continue;
        }

        // if highlighted by mouse over, skip this one
        if (poly.getAttribute("fill") == poly.getAttribute("stroke")) {
            continue;
        }

        // if already highlighted by us, skip
        if (poly.getAttribute("stroke-opacity") == 0.987) {
            continue;
        }

        // flag this venue as highlighted so we don't update it next time
        poly.setAttribute("stroke-opacity", 0.987);
        updates++;

        const categories = venue.categories;

        if (showIncomplete || specificCity) {
            var address = wmeSDK.DataModel.Venues.getAddress({venueId: venue.id});
            var venueStreet = streetData.find(({id}) => id == address.street.id);
        }

        if (showIncomplete) {
            let incomplete = false;
            let colorhilite = false;

            // check for missing venue name (ignoring residentials)
            if (!venue.name) {
                incomplete = !venue.isResidential;
                colorhilite = true;
            }

            // check for missing street name
            if (!venueStreet?.name) {
                incomplete = true;
                colorhilite = true;
            }

            // check for missing house number
            else if (venue.isResidential && venueStreet?.houseNumber == null) {
                incomplete = true;
                colorhilite = true;
            }

            // check for category group used as category
            else if (categories.isEmpty
                || venueMainCategories.some(category => categories.includes(category))) {
                incomplete = (venue.lockRank == 0);
            }
            else if (venue.externalProviderIds?.length === 0) {
                incomplete = true;
            }

            const skipColoringCategories = [
                "JUNCTION_INTERCHANGE",
                "CANAL",
                "RIVER_STREAM",
                "SEA_LAKE_POOL",
                "PARK",
                "SWAMP_MARSH",
                "FOREST_GROVE",
                "GOLF_COURSE"
            ];

            if (incomplete && skipColoringCategories.some(category => categories.includes(category))) {
                incomplete = false;
                colorhilite = false;
            }

            if (incomplete) {
                if (colorhilite) {
                    highlightAPlace(venue, "orange", "white");
                }
                if (venue.geometry.type === "Point")
                    poly.setAttribute("stroke-dasharray", "3 3");
                else {
                    poly.setAttribute("stroke-dasharray", "3 6");
                    poly.setAttribute("stroke-width", "3");
                }
            }
        }

        // highlight places which have the City field set in the address = pink
        if (specificCity && venueStreet?.cityId != null) {
            let selectedCityMatch = (specificCity && venueStreet.cityId == selectedCityId);
            if (specificCityInvert) selectedCityMatch = !selectedCityMatch;

            if (selectedCityMatch) {
                highlightAPlace(venue, "#ed28ea", "#f8f");
                continue;
            }
        }

        // highlight places which have been edited by selected editor = green
        if (specificEditor) {
            if (selectedEditorId === venue.modificationData.updatedBy) {
                highlightAPlace(venue, "#0f0", "#8f8");
                continue;
            }
        }

        // highlight places that have been edited recently
        if (showRecent) {
            const today = new Date();
            let editDays = (today.getTime() - venue.modificationData.createdOn) / 86400000;
            if (!venue.modificationData.updatedOn) {
                editDays = (today.getTime() - venue.modificationData.updatedOn) / 86400000;
            }
            if (editDays <= recentDays) {
                const shade = Math.floor(editDays * 128 / recentDays);
                const colour = "rgb(" + (0) + ", " + (255 - shade) + ", " + (0) + ")";
                highlightAPlace(venue, colour, colour);
                continue;
            }
        }

        // residential = cyan edges, like house numbers
        if (venue.isResidential) {
            highlightAPlace(venue, "#44afcf", "4ac");
        }

        // gas station = orange
        else if (categories.indexOf("GAS_STATION") > -1) {
            highlightAPlace(venue, "#f90", "#f91");
        }

        // parking lot = cyan
        else if (categories.indexOf("PARKING_LOT") > -1) {
            const parkingLotType = wmeSDK.DataModel.Venues.getParkingLotType({venueId: venue.id});
            if (!parkingLotType) {
                highlightAPlace(venue, "#099", "#0cc");
                poly.setAttribute("stroke-dasharray", "3 6");
            }
            else if (parkingLotType === "PUBLIC") {
                highlightAPlace(venue, "#090", "#0cc");
            }
            else if (parkingLotType === "RESTRICTED") {
                highlightAPlace(venue, "#aa0", "#0cc");
            }
            else if (parkingLotType === "PRIVATE") {
                highlightAPlace(venue, "#a50", "#0cc");
            }
        }

        // water = blue
        else if (categories.indexOf("RIVER_STREAM") > -1 ||
            categories.indexOf("CANAL") > -1 ||
            categories.indexOf("SEA_LAKE_POOL") > -1) {
            highlightAPlace(venue, "#06c", "#09f");
            poly.setAttribute("stroke-dasharray", "none");
        }

        // park/grass/trees = green
        else if (!showRecent && !specificEditor && (
            categories.indexOf("PARK") > -1 ||
            categories.indexOf("SWAMP_MARSH") > -1 ||
            categories.indexOf("FOREST_GROVE") > -1 ||
            categories.indexOf("GOLF_COURSE") > -1)) {
            highlightAPlace(venue, "#0b0", "#4f4");
            poly.setAttribute("stroke-dasharray", "none");
        }

        // locked venues have red border (overrides all other options)
        if (showLocked && venue.lockRank > 0) {
            poly.setAttribute("stroke", "red");
        }
    } // for
}

function highlightAPlace(venue, fg, bg) {
    const poly = wmeSDK.Map.getFeatureDomElement({featureId: venue.id, layerName: "venues"});
    if (venue.geometry.type === "Point") {
        poly.setAttribute("fill", fg);
    }

    else { // area
        poly.setAttribute("stroke", fg);
        poly.setAttribute("fill", bg);
    }
}

function getAllPermanentHazards() {
    return W.model.permanentHazards.getObjectArray().map((object) => ({
        id: object.getID(),
        modificationData: {
            createdOn: object.attributes.createdOn,
            createdBy: W.model.users.getObjectById(object.attributes.createdBy)?.attributes.userName,
            updatedOn: object.attributes.updatedOn,
            updatedBy: W.model.users.getObjectById(object.attributes.updatedBy)?.attributes.userName,
        },
    }));
}

function highlightPermanentHazards(event) {
    const showHazards = getId('_cbHighlightPermanentHazards').checked;

    // refreshing, reset hazards to original style
    if (event?.type && /click|change/.test(event.type)) {
        for (const hazard of getAllPermanentHazards()) {
            const symbol = wmeSDK.Map.getFeatureDomElement({
                featureId: hazard.id,
                layerName: PERMANENT_HAZARDS_HIGHLIGHTING_LAYER
            });

            symbol?.setAttribute?.("fill", 'transparent');
        }
    }

    // if option is disabled, stop now
    if (!showHazards) {
        return;
    }

    const shouldHighlightAsEdited = (() => {
        const specificEditorId = (() => {
            if (!getId('_cbHighlightEditor').checked) return null;

            const selectEditor = getId('_selectUser');
            if (!selectEditor || selectEditor.selectedIndex < 0) return null;

            const editorName = selectEditor.options[selectEditor.selectedIndex].value;
            return editorName === NOT_THIS_USER ? true : editorName;
        })();
        const showRecent = (() => {
            if (!getId('_cbHighlightRecent').checked) return null;

            const recentDays = getId('_numRecentDays');
            if (!recentDays || typeof recentDays.value === 'undefined') return null;
            return recentDays.value;
        })();

        return (hazard) => {
            const isMatchSpecificEditor = (() => {
                if (specificEditorId === null) return false;
                if (specificEditorId === true)
                    return hazard.modificationData.updatedBy !== wmeSDK.State.getUserInfo().userName;
                return hazard.modificationData.updatedBy === specificEditorId;
            })();
            const isMatchRecent = showRecent !== null && (() => {
                const today = new Date();
                let editDays = (today.getTime() - hazard.modificationData.createdOn) / 86400000;
                if (hazard.modificationData.updatedOn !== null) {
                    editDays = (today.getTime() - hazard.modificationData.updatedOn) / 86400000;
                }
                return editDays <= showRecent;
            })();

            if (specificEditorId !== null && showRecent !== null) {
                // both conditions must be met
                return isMatchSpecificEditor && isMatchRecent;
            }
            
            return isMatchRecent || isMatchSpecificEditor;
        };
    })();


    for (const hazard of getAllPermanentHazards()) {
        const symbol = wmeSDK.Map.getFeatureDomElement({featureId: hazard.id, layerName: PERMANENT_HAZARDS_HIGHLIGHTING_LAYER});
        if (!symbol) continue;

        const newFill = shouldHighlightAsEdited(hazard) ? '#0f0' : 'transparent';

        symbol.setAttribute("fill", newFill);
    }
}

// used when clicking an option that affects both Segments and Places
function highlightSegmentsAndPlaces(event) {
    highlightSegments(event);
    highlightPlaces(event);
}

function createHighlightMultipleLayers(segments, places, permanentHazards) {
    return function(event) {
        if (segments) highlightSegments(event);
        if (places) highlightPlaces(event);
        if (permanentHazards) highlightPermanentHazards(event);
    }
}

// add logged in user to drop-down list
function initUserList() {
    const thisUser = wmeSDK.State.getUserInfo();
    if (thisUser === null) {
        return;
    }

    const selectUser = getId('_selectUser');
    const usrOption = document.createElement('option');
    const usrText = document.createTextNode(thisUser.userName);
    usrOption.setAttribute('value', thisUser.userName);
    usrOption.appendChild(usrText);
    selectUser.appendChild(usrOption);
    console.info("WME Highlights: Init User list: " + thisUser.userName);
}

// add current city in to drop-down list
function initCityList() {
    const thisCity = wmeSDK.DataModel.Cities.getTopCity();
    if (thisCity == null) {
        return;
    }
    const cityName = thisCity.name;

    const selectCity = getId('_selectCity');
    const cityOption = document.createElement('option');
    const cityText = document.createTextNode(cityName);
    cityOption.appendChild(cityText);
    cityOption.setAttribute('value', thisCity.id);
    selectCity.appendChild(cityOption);
    console.info("WME Highlights: Init City list: " + cityName);

    wmeSDK.Events.off({
        eventName: "wme-map-data-loaded",
        eventHandler: initCityList,
    });
}

// populate drop-down list of editors
function updateUserList() {
    let editedBy;
    const selectUser = getId('_selectUser');

    // preserve current selection
    let currentId = null;
    if (selectUser.selectedIndex >= 0)
        currentId = selectUser.options[selectUser.selectedIndex].value;

    // collect array of users who have edited segments
    const editorNames = [];
    for (let segment of wmeSDK.DataModel.Segments.getAll()) {
        if (!segment) {
            continue;
        }
        editedBy = segment.modificationData.createdBy;
        if (segment.modificationData.updatedBy) {
            editedBy = segment.modificationData.updatedBy;
        }
        if (editorNames.indexOf(editedBy) == -1) {
            editorNames.push(editedBy);
        }
    }
    // collect array of users who have edited places
    for (const venue of wmeSDK.DataModel.Venues.getAll()) {
        editedBy = venue.modificationData.createdBy;
        if (venue.modificationData.updatedBy) {
            editedBy = venue.modificationData.updatedBy;
        }
        if (editorNames.indexOf(editedBy) == -1) {
            editorNames.push(editedBy);
        }
    }
    // collect array of users who have edited permanent hazards
    for (const hazard of getAllPermanentHazards()) {
        editedBy = hazard.modificationData.createdBy;
        if (hazard.modificationData.updatedBy) {
            editedBy = hazard.modificationData.updatedBy;
        }
        if (editorNames.indexOf(editedBy) == -1) {
            editorNames.push(editedBy);
        }
    }
    if (editorNames.length === 0) {
        return;
    }

    editorNames.filter(x => x).sort(function (a, b) {
        return a.localeCompare(b);
    });

    // reset list
    selectUser.options.length = 0;

    // add all users in field of view
    for (const id of editorNames) {
        if (!id) {
            continue;
        }

        var usrOption = document.createElement('option');
        var usrText = document.createTextNode(id);
        if (currentId !== null && id == currentId) {
            usrOption.setAttribute('selected', true);
        }
        usrOption.setAttribute('value', id);
        usrOption.appendChild(usrText);
        selectUser.appendChild(usrOption);
    }

    const thisUser = wmeSDK.State.getUserInfo();
    if (thisUser !== null) {
        usrOption = document.createElement('option');
        usrText = document.createTextNode("(all except me)");
        if (currentId !== null && -thisUser.userName == currentId) {
            usrOption.setAttribute('selected', true);
        }
        usrOption.setAttribute('value', NOT_THIS_USER);
        usrOption.appendChild(usrText);
        selectUser.appendChild(usrOption);
    }
}

// populate drop-down list of Cities
function updateCityList() {
    const selectCity = getId('_selectCity');
    const cities = wmeSDK.DataModel.Cities.getAll();

    if (cities.isEmpty) {
        return;
    }

    // preserve current selection
    let currentId = null;
    if (selectCity.selectedIndex >= 0) {
        currentId = selectCity.options[selectCity.selectedIndex].value;
    }

    //=========================================================================================
    // This new block of code checks the following assumed conditions:
    // * Every U.S. city should have an associated state
    // * Every 'No city' U.S. city should be properly numbered (not an orphan blank city)
    // * We only care about states if get.cities shows us close enough to the U.S. to matter
    // * Any non US's city state code should be 99 (None/other)
    //========================================================================================

    // reset list
    selectCity.options.length = 0;

    const states = wmeSDK.DataModel.States.getAll();
    const numStates = states.filter(state => state.id != 1 && state.name != "").length;

    const countries = wmeSDK.DataModel.Countries.getAll()
    const numCountries = countries.length;

    // add all cities in field of view
    cities.sort(function (a, b) {
        return a.name.localeCompare(b.name)
    });
    for (const city of cities) {
        const cityID = city.id;
        // "State-like CityIDs" to ignore. These are consistently over 100,000,000.
        if (cityID > 100000000) {
            continue;
        }
        let cityName = city.name;
        const stateID = city.stateId;
        const countryID = city.countryId;

        if (countryID == 235) {  // for U.S. only
            // 'No City' segments in the U.S. should have an assigned state.
            // This ID has a prescribed range. If not in this range, we get 'other' state pollution in map,
            // or a bogus blank city associated to the state.

            if (city.isEmpty) {
                if (cityID >= 999900 && cityID <= 999999) {
                    cityName = "No City";
                }
                else {
                    cityName = "EMPTY CITY";
                }
            }
        }

        else { // for non U.S. segments
            if (city.isEmpty) {
                cityName = "No City";
            }
        }

        // State handling. All cities should have an associated state. Throw an error if not.
        if (numStates > 0) {
            const state = states.find(({id}) => id == stateID);
            // If more than one state, we're appending it. No brainer.
            if (numStates > 1) {
                // ... and, if one of those states is 'Other', that's an error. Report it.
                if (state.id === 99) {
                    cityName += ", " + "NO STATE";
                }
                // If we get here, the state ID should be fine. Append it.
                else {
                    cityName += ", " + state.name;
                }
            }

            // If we have more than one country and are in the US, append the state for sanity.
            if (numStates == 1 && numCountries > 1) {
                cityName += ", " + state.name;
            }
        }

            // If we're on a non-US street, state should always be 99, 'Other/none'.
        // Append if this is the case. Otherwise don't add anything.
        else if (stateID != 99 && stateID > 1) {
            cityName += ", INVALID STATE";
        }

        if (numCountries > 1) {
            const country = countries.find(({id}) => id == countryID);
            cityName += ", " + country.name.replace('United States', 'U.S.');
        }

        // create option in select menu
        const cityOption = document.createElement('option');
        const cityText = document.createTextNode(cityName);

        if (currentId !== null && cityID == currentId) {
            cityOption.setAttribute('selected', true);
        }

        cityOption.setAttribute('value', cityID);
        cityOption.appendChild(cityText);
        selectCity.appendChild(cityOption);
    }
}

const RoadTypes = {
    1: I18n.translations[I18n.locale].segment.road_types[1],                     // Street
    22: "- " + I18n.translations[I18n.locale].segment.road_types[22],                    // Narrow Street
    98: I18n.translations[I18n.locale].segment.categories.other_drivable,    // --------------
    108: "- " + I18n.translations[I18n.locale].segment.road_types[8],              // Off-Road / Not Maintained
    120: "- " + I18n.translations[I18n.locale].segment.road_types[20],             // Parking Lot Road
    117: "- " + I18n.translations[I18n.locale].segment.road_types[17],             // Private Road
    115: "- " + I18n.translations[I18n.locale].segment.road_types[15],             // Ferry
    199: I18n.translations[I18n.locale].segment.categories.non_drivable,    // --------------
    210: "- " + I18n.translations[I18n.locale].segment.road_types[10],             // Pedestrian Bw
    205: "- " + I18n.translations[I18n.locale].segment.road_types[5],              // Walking Trails
    216: "- " + I18n.translations[I18n.locale].segment.road_types[16],             // Stairway
    219: "- " + I18n.translations[I18n.locale].segment.road_types[19],             // Runway/Taxiway
//  2: "Primary Street",
//  3: "Freeways",
//  4: "Ramps",
//  6: "Major Highway",
//  7: "Minor Highway",
// 18: "Railroad",
// 14: "Ferry',
    364: "Special Flags",    // --------------
    365: "- " + I18n.translations[I18n.locale].edit.segment.fields.tunnel,
    366: "- " + I18n.translations[I18n.locale].edit.segment.fields.tunnel
        + " / " + I18n.translations[I18n.locale].edit.segment.fields.level,
    367: "- " + I18n.translations[I18n.locale].edit.segment.fields.unpaved,
    368: "- " + I18n.translations[I18n.locale].edit.segment.fields.headlights,
    369: "- " + I18n.translations[I18n.locale].edit.segment.fields.beacons,
    370: "- " + I18n.translations[I18n.locale].edit.segment.fields.nearbyHOV
};

const majorRoadTypes = [2, 3, 4, 6, 7];
var nonRoutableTypes = [8, 20, 17];
var nonDrivableTypes = [5, 10, 16, 18, 19, 14];

function populateRoadTypes() {
    const selectRoadType = getId('_selectRoadType');

    for (let id in RoadTypes) {
        const type = RoadTypes[id];
        const usrOption = document.createElement('option');
        const usrText = document.createTextNode(type);
        if (id == 1) {
            usrOption.setAttribute('selected', true);
        }
        usrOption.setAttribute('value', id % 100);
        usrOption.appendChild(usrText);
        selectRoadType.appendChild(usrOption);
    }
}

function getId(node) {
    return document.getElementById(node);
}

function initVenueMainCategories() {
    venueMainCategories = wmeSDK.DataModel.Venues.getVenueMainCategories()
        .map(venue => venue.id)
        .filter(venueId => venueId !== 'PARKING_LOT' && venueId !== 'CRISIS_LOCATIONS');
}

/* =========================================================================== */
async function initialiseHighlights() {
    console.group("WME Color Highlights: " + wmech_version);

    initPermanentHazardsLayer();

    const scriptTab = await wmeSDK.Sidebar.registerScriptTab();

    const section = document.createElement('section');
    section.id = "highlight-addon";

    const highlightOptionsSection = document.createElement('p');
    highlightOptionsSection.id = "highlightOptions";
    highlightOptionsSection.className = 'checkbox';
    highlightOptionsSection.innerHTML = `
            <b>Highlight Segments</b><br>
            <label title="Dotted = Automatic Locks (if available)"><input type="checkbox" id="_cbHighlightLocked" title="Locked Segments" /> Locks* (Red)</label><br>
            <label><input type="checkbox" id="_cbHighlightToll" /> Toll (Dashed)</label><br>
            <label title="Dotted = No Name"><input type="checkbox" id="_cbHighlightAltName" /> Alternate Name* (Lime)</label><br>
            <label title="Segments with unverified speed limits (Orange)"><input type="checkbox" id="_cbHighlightSpeedLimits" /> No Speed Limit</label>
            &nbsp; <label><input type="checkbox" id="_cbHighlightPlusRampLimits" />+Ramps</label>
            &nbsp; <label><input type="checkbox" id="_cbHighlightPlusStreetLimits" />+Streets</label><br>
            <label title="Average Speed Camera Zone"><input type="checkbox" id="_cbHighlightAvgSpeedCams" /> Avg Speed Cams (Blue)</label><br>
            <label><input type="checkbox" id="_cbHighlightUnnamed" /> No Name (Orange)</label><br>
            <label><input type="checkbox" id="_cbHighlightNoCity" /> No City (Gray)</label><br>
            <label><input type="checkbox" id="_cbHighlightOneWay" /> One Way (Blue)</label><br>
            <label><input type="checkbox" id="_cbHighlightRestrictions" /> Time/Vehicle Restrictions (Purple)</label><br>
            <label title="excluding Freeways and Ramps"><input type="checkbox" id="_cbHighlightNoHN" /> No House Numbers* (Dashed Maroon)</label><br>
            <label><input type="checkbox" id="_cbHighlightCity" /> Filter by City (Pink)</label> &nbsp;
            <label><input type="checkbox" id="_cbHighlightCityInvert" /> invert</label><br>
            <select id="_selectCity" name="_selectCity" style="margin: 0 0 4px 20px"></select>
            <span id="_numCityHighlighted"></span><br>
            <label><input type="checkbox" id="_cbHighlightRoadType" /> Highlight a Road Type (Purple)</label><br>
            <select id="_selectRoadType" name="_selectRoadType" style="margin: 0 0 4px 20px"></select><br>
        `;
    section.appendChild(highlightOptionsSection);

    const advancedOptionsSection = document.createElement('p');
    advancedOptionsSection.id = 'advancedOptions';
    advancedOptionsSection.className = 'checkbox';
    advancedOptionsSection.innerHTML = `
            <b>Advanced Options</b><br>
            <label><input type="checkbox" id="_cbHighlightRecent" /> Recently Edited (Green)</label><br>
            <input type="number" min="0" max="365" size="3" id="_numRecentDays" style="margin: 0 0 4px 20px" /> days<br>
            <label><input type="checkbox" id="_cbHighlightEditor" /> Filter by Editor (Green)</label><br>
            <select id="_selectUser" name="_selectUser" style="margin: 0 0 4px 20px"></select>
            <span id="_numUserHighlighted"></span><br>
            <label><input type="checkbox" id="_cbHighlightRoutingPref" /> Routing Preference (Mixed)</label><br>
            <label title="Lane Guidance"><input type="checkbox" id="_cbHighlightLanes" /> Lane Guidance (Cyan)</label><br>
        `;
    section.appendChild(advancedOptionsSection);

    const highlightPlacesSection = document.createElement('p');
    highlightPlacesSection.id = "highlightPlaces";
    highlightPlacesSection.className = 'checkbox';
    highlightPlacesSection.innerHTML = `
            <label title="parks/trees = green, water = blue, parking lot = cyan, everything else = pink">
                <input type="checkbox" id="_cbHighlightPlaces" /><b>Highlight Places</b>*
            </label>
            <label><input type="checkbox" id="_cbHighlightLockedPlaces" /> Locked Places* (Red)</label><br>
            <label title="If blank name or street, or wrong category"><input type="checkbox" id="_cbHighlightIncompletePlaces" /> Incomplete Places (Dashed Orange)</label><br>
        `;
    section.appendChild(highlightPlacesSection);

    const highlightHazardsSection = document.createElement('p');
    highlightHazardsSection.id = "highlightPermanentHazards";
    highlightHazardsSection.className = 'checkbox';
    highlightHazardsSection.innerHTML = `
            <label title="Highlight Permanent Hazards edited recently or by selected editor">
                <input type="checkbox" id="_cbHighlightPermanentHazards" />
                <b>Highlight Permanent Hazards</b>
            </label><br>
            <i style="padding-left: 20px">Show recent edits or last editor</i>
        `;
    section.appendChild(highlightHazardsSection);

    // Add footer link
    section.innerHTML += `
            <b><a href="https://greasyfork.org/scripts/3206-wme-color-highlights" target="_blank"><u>WME Color Highlights</u></a></b> &nbsp; v${wmech_version}
        `;

    scriptTab.tabLabel.innerText = 'Highlight';
    scriptTab.tabPane.innerHTML = section.innerHTML;

    // initialise drop-downs
    //initUserList();
    //initCityList();
    populateRoadTypes();

    initVenueMainCategories();

    // setup onclick handlers for instant update:
    getId('_cbHighlightLocked').onclick = highlightSegments;
    getId('_cbHighlightToll').onclick = highlightSegments;
    getId('_cbHighlightUnnamed').onclick = highlightSegments;
    getId('_cbHighlightNoCity').onclick = highlightSegments;
    getId('_cbHighlightOneWay').onclick = highlightSegments;
    getId('_cbHighlightRestrictions').onclick = highlightSegments;
    getId('_cbHighlightSpeedLimits').onclick = highlightSegments;
    getId('_cbHighlightPlusRampLimits').onclick = highlightSegments;
    getId('_cbHighlightPlusStreetLimits').onclick = highlightSegments;
    getId('_cbHighlightAvgSpeedCams').onclick = highlightSegments;
    getId('_cbHighlightLanes').onclick = highlightSegments;
    getId('_cbHighlightRoutingPref').onclick = highlightSegments;
    getId('_cbHighlightNoHN').onclick = highlightSegments;

    getId('_cbHighlightRecent').onclick = createHighlightMultipleLayers(true, true, true);
    getId('_cbHighlightEditor').onclick = createHighlightMultipleLayers(true, true, true);
    getId('_cbHighlightCity').onclick = highlightSegmentsAndPlaces;
    getId('_cbHighlightCityInvert').onclick = highlightSegmentsAndPlaces;
    getId('_cbHighlightRoadType').onclick = highlightSegments;

    getId('_selectUser').onfocus = updateUserList;
    getId('_selectUser').onclick = function (e) {
        getId('_cbHighlightEditor').checked = 1;
        createHighlightMultipleLayers(true, true, true)(e);
    };

    getId('_selectCity').onfocus = updateCityList;
    getId('_selectCity').onclick = function (e) {
        getId('_cbHighlightCity').checked = 1;
        highlightSegmentsAndPlaces(e);
    };

    getId('_selectRoadType').onclick = function (e) {
        getId('_cbHighlightRoadType').checked = 1;
        highlightSegments(e);
    };

    getId('_numRecentDays').onchange = createHighlightMultipleLayers(true, true, true);
    getId('_numRecentDays').onclick = function (e) {
        getId('_cbHighlightRecent').checked = 1;
        createHighlightMultipleLayers(true, true, true)(e);
    };

    getId('_cbHighlightPlaces').onclick = highlightPlaces;
    getId('_cbHighlightLockedPlaces').onclick = highlightPlaces;
    getId('_cbHighlightIncompletePlaces').onclick = highlightPlaces;

    getId('_cbHighlightPermanentHazards').onclick = highlightPermanentHazards;


    // restore saved settings
    if (localStorage.WMEHighlightScript) {
        //console.debug("WME Highlights: loading options");
        const options = JSON.parse(localStorage.WMEHighlightScript);

        getId('_cbHighlightLocked').checked = (options[1] % 2 == 1);
        getId('_cbHighlightToll').checked = options[2];
        getId('_cbHighlightUnnamed').checked = options[3];
        getId('_cbHighlightNoCity').checked = options[4];
        getId('_cbHighlightOneWay').checked = options[5];
        getId('_cbHighlightCity').checked = options[15];
        getId('_cbHighlightRoadType').checked = options[16];
        getId('_selectRoadType').selectedIndex = options[17];
        getId('_cbHighlightPlaces').checked = options[7];
        getId('_cbHighlightRestrictions').checked = options[19];
        getId('_cbHighlightLockedPlaces').checked = options[20]; //(options[1] > 1);
        getId('_cbHighlightIncompletePlaces').checked = options[21];
        getId('_cbHighlightAltName').checked = options[22];
        getId('_cbHighlightSpeedLimits').checked = options[23];
        getId('_cbHighlightPlusRampLimits').checked = options[26];
        getId('_cbHighlightPlusStreetLimits').checked = options[24];
        getId('_cbHighlightAvgSpeedCams').checked = options[27];
        getId('_cbHighlightNoHN').checked = options[28];
        getId('_cbHighlightLanes').checked = options[29];

        if (options[12] === undefined) {
            options[12] = 7;
        }
        getId('_cbHighlightRecent').checked = options[11];
        getId('_numRecentDays').value = options[12];
        getId('_cbHighlightEditor').checked = options[13];
        getId('_cbHighlightRoutingPref').checked = options[25];

        getId('_cbHighlightPermanentHazards').checked = options[30] ?? false;
    }
    else {
        getId('_cbHighlightPlaces').checked = true;
    }

    if (!getId('_cbHighlightPlaces').checked) {
        getId('_cbHighlightLockedPlaces').disabled = true;
        getId('_cbHighlightIncompletePlaces').disabled = true;
    }

    // overload the WME exit function
    const saveHighlightOptions = function () {
        if (localStorage) {
            //console.debug("WME Highlights: saving options");
            let options = [];

            // preserve previous options which may get lost after logout
            if (localStorage.WMEHighlightScript)
                options = JSON.parse(localStorage.WMEHighlightScript);

            options[1] = 1 * getId('_cbHighlightLocked').checked + 2 * getId('_cbHighlightLockedPlaces').checked;
            options[2] = getId('_cbHighlightToll').checked;
            options[3] = getId('_cbHighlightUnnamed').checked;
            options[4] = getId('_cbHighlightNoCity').checked;
            options[5] = getId('_cbHighlightOneWay').checked;
            options[7] = getId('_cbHighlightPlaces').checked;
            options[15] = getId('_cbHighlightCity').checked;
            options[16] = getId('_cbHighlightRoadType').checked;
            options[17] = getId('_selectRoadType').selectedIndex;
            options[19] = getId('_cbHighlightRestrictions').checked;
            options[20] = getId('_cbHighlightLockedPlaces').checked;
            options[21] = getId('_cbHighlightIncompletePlaces').checked;
            options[22] = getId('_cbHighlightAltName').checked;
            options[23] = getId('_cbHighlightSpeedLimits').checked;
            options[24] = getId('_cbHighlightPlusStreetLimits').checked;
            options[26] = getId('_cbHighlightPlusRampLimits').checked;
            options[27] = getId('_cbHighlightAvgSpeedCams').checked;
            options[28] = getId('_cbHighlightNoHN').checked;
            options[29] = getId('_cbHighlightLanes').checked;

            // advanced
            options[11] = getId('_cbHighlightRecent').checked;
            options[12] = getId('_numRecentDays').value;
            options[13] = getId('_cbHighlightEditor').checked;
            options[25] = getId('_cbHighlightRoutingPref').checked;

            // permanent hazards
            options[30] = getId('_cbHighlightPermanentHazards').checked;

            localStorage.WMEHighlightScript = JSON.stringify(options);
        }
    };
    window.addEventListener("beforeunload", saveHighlightOptions, false);

    wmeSDK.Events.on({
        eventName: "wme-map-data-loaded",
        eventHandler: highlightObjectsOnDataLoaded,
    });

    wmeSDK.Events.on({
        eventName: "wme-map-mouse-move",
        eventHandler: highlightObjectsOnMouseMove,
    });

    wmeSDK.Events.on({
        eventName: "wme-map-data-loaded",
        eventHandler: initCityList,
    });
    console.groupEnd();
}

const highlightObjectsOnDataLoaded = debounce(function () {
    highlightSegments();
    highlightPlaces();
    highlightPermanentHazards();
}, 300);

const highlightObjectsOnMouseMove = debounce(function () {
    highlightSegments();
    highlightPlaces();
    highlightPermanentHazards();
}, 250);

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}
