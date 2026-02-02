import { capitalizeWord, formatNumber, formatCurrency, coordKey, roundedKey, capitalRecoveryFactor as crf } from './utils.js';
import {
    CF_COLOR_SCALE,
    FUEL_COLORS,
    ALL_FUELS,
    LCOE_NO_DATA_COLOR,
    ACCESS_COLOR_SCALE,
    POTENTIAL_MULTIPLE_BUCKETS,
    POTENTIAL_TOTAL_COLORS
} from './constants.js';
import { createSharedPopup, buildTooltipHtml, buildCfTooltip, buildPlantTooltip } from './tooltip.js';

let map;
let markersLayer;
let overlayLayer;
let voronoiLayer;
let markerRenderer;
let selectedMarker = null;
let sampleMarkers = new Map();
let currentMode = 'capacity';
let activeLayerMode = null;
let lastDataIsFiltered = false;
let sampleLocationHandler = null;
let populationOverlay = false;
let populationData = null;
let populationScale = null;
const ALL_FOSSIL_FUELS = ALL_FUELS;
const FOSSIL_COLORS = FUEL_COLORS;

const capacityMarkers = new Map();
let capacityMarkersActive = false;
let capacityPopup = null;

let sampleMarkersActive = false;
let samplePopup = null;
let lastSampleVoronoiKey = null;

let currentAccessMetric = 'reliability'; // 'reliability' or 'no_access'

export function setAccessMetric(metric) {
    currentAccessMetric = metric;
}

const POTENTIAL_LEVEL_LABELS = {
    level1: 'Technical constraints',
    level2: 'Policy constraints'
};

function getPotentialLevelLabel(level) {
    return POTENTIAL_LEVEL_LABELS[level] || POTENTIAL_LEVEL_LABELS.level1;
}

// Color scale for Capacity Factor (0.0 to 1.0)
const colorScale = d3.scaleLinear()
    .domain(CF_COLOR_SCALE.domain)
    .range(CF_COLOR_SCALE.range)
    .interpolate(d3.interpolateRgb)
    .clamp(true);

function getColor(cf) {
    return colorScale(cf);
}

function buildPopulationScale(values) {
    const valid = values.filter(Number.isFinite);
    const min = valid.length ? Math.min(...valid) : 0;
    const max = valid.length ? Math.max(...valid) : 1;
    return d3.scaleLinear()
        .domain([min, max])
        .range(["#111827", "#f3f4f6"])
        .clamp(true);
}

function buildLcoeScale(domain, options = {}) {
    const defaultDomain = [0, 25, 50, 75, 100, 200];
    const scaleDomain = Array.isArray(domain) && domain.length >= 3 ? domain.slice() : defaultDomain;
    const underflowMin = Number.isFinite(options.underflowMin) ? options.underflowMin : null;
    // Ensure strictly increasing values to satisfy d3
    for (let i = 1; i < scaleDomain.length; i++) {
        if (scaleDomain[i] <= scaleDomain[i - 1]) {
            scaleDomain[i] = scaleDomain[i - 1] + 1;
        }
    }
    const baseRange = ["#0b1d3a", "#1d4ed8", "#16a34a", "#eab308", "#f59e0b", "#dc2626"];
    let range = baseRange;
    if (scaleDomain.length === 4) {
        range = [baseRange[0], baseRange[2], baseRange[4], baseRange[5]];
    } else if (scaleDomain.length === 5) {
        range = [baseRange[0], baseRange[1], baseRange[2], baseRange[4], baseRange[5]];
    } else if (scaleDomain.length < 4) {
        range = [baseRange[0], baseRange[4], baseRange[5]];
    }
    if (underflowMin !== null && scaleDomain[0] > underflowMin) {
        scaleDomain.unshift(underflowMin);
        range = [baseRange[0], ...range];
    }
    return d3.scaleLinear()
        .domain(scaleDomain)
        .range(range)
        .clamp(true);
}

function buildTxScale(domain) {
    const defaultDomain = [0, 100, 500];
    const scaleDomain = Array.isArray(domain) && domain.every(v => Number.isFinite(v))
        ? domain : defaultDomain;
    return d3.scaleLinear()
        .domain(scaleDomain)
        .range(["#cbd5e1", "#86efac", "#22c55e"])
        .clamp(true);
}

function buildDeltaScale(maxAbs) {
    const span = Math.max(1, maxAbs || 1);
    return d3.scaleDiverging()
        .domain([-span, 0, span])
        .interpolator(d3.interpolateRgbBasis(["#22c55e", "#cbd5e1", "#ef4444"]))
        .clamp(true);
}

function buildLcoeColorScaleFromInfo(colorInfo) {
    if (!colorInfo) {
        return buildLcoeScale();
    }
    if (colorInfo.type === 'delta') {
        return buildDeltaScale(colorInfo.maxAbs || 1);
    }
    if (colorInfo.type === 'tx') {
        return buildTxScale(colorInfo.domain);
    }
    return buildLcoeScale(colorInfo.domain, { underflowMin: colorInfo.underflowMin });
}

function getLcoeColor(row, colorInfo, colorScale) {
    if (!row || !colorInfo || !colorScale) return '#611010';
    if (!row.meetsTarget) return '#611010';
    if (colorInfo.type === 'delta') {
        return Number.isFinite(row.delta) ? colorScale(row.delta) : '#611010';
    }
    if (colorInfo.type === 'tx') {
        const val = row.txMetrics ? row.txMetrics.breakevenPerGwKm : 0;
        return val > 0 ? colorScale(val) : '#611010';
    }
    return colorScale(row.lcoe);
}

let worldGeoJSON = null;

function clearVoronoi() {
    if (!voronoiLayer) return;
    d3.select(voronoiLayer._container).selectAll("*").remove();
}

function resetLayersForMode(mode, { preserveVoronoi = false } = {}) {
    const modeChanged = activeLayerMode !== mode;
    if (modeChanged) {
        if (markersLayer) markersLayer.clearLayers();
        if (overlayLayer) overlayLayer.clearLayers();
        if (!preserveVoronoi) clearVoronoi();
        activeLayerMode = mode;
        capacityMarkersActive = false;
        sampleMarkersActive = false;
        selectedMarker = null;
    } else {
        if (overlayLayer) overlayLayer.clearLayers();
        if (!preserveVoronoi) clearVoronoi();
    }
    return modeChanged;
}

export async function initMap(onLocationSelect) {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false
    }).setView([20, 0], 2); // World view

    markerRenderer = L.canvas({ padding: 0.5 });

    // Dark Matter basemap
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(map);

    // Zoom disabled

    map.createPane('markers');
    map.getPane('markers').style.zIndex = 600;

    markersLayer = L.layerGroup().addTo(map);
    overlayLayer = L.layerGroup().addTo(map);
    voronoiLayer = L.svg().addTo(map);

    // Re-render Voronoi on move
    map.on('moveend', () => {
        if (currentMode === 'capacity' && lastData && lastSolar !== null && lastBatt !== null) {
            updateMap(lastData, lastSolar, lastBatt, { preFiltered: lastDataIsFiltered });
        } else if (currentMode === 'lcoe' && lastLcoeData) {
            updateLcoeMap(lastLcoeData, lastLcoeOptions || {});
        } else if (currentMode === 'lcoe_cf' && lastCfData) {
            updateCfMap(lastCfData, lastCfOptions || {});
        } else if (currentMode === 'samples' && lastSampleFrame) {
            updateMapWithSampleFrame(lastSampleFrame);
        }
    });

    // Store callback
    map.onLocationSelect = onLocationSelect;

    try {
        // Use a lightweight world GeoJSON (~100KB) for performance
        const response = await fetch("https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson");
        if (response.ok) {
            worldGeoJSON = await response.json();
        } else {
            console.error("Failed to load GeoJSON:", response.statusText);
        }
    } catch (err) {
        console.error("Could not load world GeoJSON data:", err);
    }
}

let lastData = null;
let lastSolar = null;
let lastBatt = null;
let lastLcoeData = null;
let lastLcoeOptions = null;
let lastCfData = null; // Data for Target Mode (CF Map)
let lastCfOptions = null; // Options for Target Mode (CF Map)
let lastSampleFrame = null;
let lastPopulationData = null;

function updateLocationPanel(data, color, mode) {
    const panel = document.getElementById('location-panel');
    if (!panel) return;

    const coordsEl = document.getElementById('loc-coords');
    const valueEl = document.getElementById('loc-value');
    const labelEl = document.getElementById('loc-label');
    const configEl = document.getElementById('loc-config');
    const configTextEl = document.getElementById('loc-config-text');
    const txInfoEl = document.getElementById('loc-tx-info');
    const txMwhEl = document.getElementById('loc-tx-mwh');
    const txGwKmEl = document.getElementById('loc-tx-gwkm');

    coordsEl.textContent = `${data.latitude.toFixed(2)}, ${data.longitude.toFixed(2)}`;
    valueEl.style.color = color || '#fff';

    if (mode === 'capacity') {
        valueEl.textContent = (data.annual_cf * 100).toFixed(1) + '%';
        labelEl.textContent = 'Annual Capacity Factor (share of the year 1 MW baseload is met)';
        configEl.classList.remove('hidden');
        if (configTextEl) {
            configTextEl.textContent = `Solar ${lastSolar} MW_DC (per MW load) • Battery ${lastBatt} MWh (per MW load) powering a steady 1 MW baseload.`;
        }
        if (txInfoEl) {
            txInfoEl.classList.add('hidden');
        }
    } else if (mode === 'lcoe') {
        const targetText = data.targetCf ? `target ${(data.targetCf * 100).toFixed(0)}% CF for 1 MW baseload` : 'target CF for 1 MW baseload';
        const deltaText = Number.isFinite(data.delta)
            ? ` (Δ ${data.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(data.delta), 1)}/MWh vs reference)`
            : '';
        if (data.meetsTarget) {
            valueEl.textContent = data.lcoe ? `${formatCurrency(data.lcoe)}/MWh` : '--';
            labelEl.textContent = `Best LCOE meeting ${targetText}${deltaText}`;
        } else {
            const maxText = data.maxConfigLcoe ? `>${formatCurrency(data.maxConfigLcoe)}/MWh` : '--';
            valueEl.textContent = maxText;
            labelEl.textContent = 'Target CF not met for 1 MW requirement in this region';
        }
        configEl.classList.remove('hidden');
        if (configTextEl) {
            if (data.meetsTarget) {
                configTextEl.textContent = `Solar ${data.solar_gw} MW_DC • Battery ${data.batt_gwh} MWh serving 1 MW baseload.`;
            } else {
                const solar = data.maxConfigSolar ?? data.solar_gw;
                const batt = data.maxConfigBatt ?? data.batt_gwh;
                configTextEl.textContent = `Highest config: Solar ${solar ?? '--'} MW_DC • Battery ${batt ?? '--'} MWh`;
            }
        }
        if (txInfoEl) {
            if (data.meetsTarget && data.txMetrics && data.txMetrics.breakevenPerGw > 0) {
                txInfoEl.classList.remove('hidden');
                if (txMwhEl) {
                    txMwhEl.textContent = `${formatCurrency(data.txMetrics.savingsPerMwh, 2)}/MWh`;
                }
                if (txGwKmEl) {
                    txGwKmEl.textContent = `${formatCurrency(data.txMetrics.breakevenPerGwKm / 1000)}/MW/km`;
                }
            } else {
                txInfoEl.classList.add('hidden');
            }
        }
    } else if (mode === 'population') {
        const popVal = data.population_2020 || 0;
        valueEl.textContent = formatNumber(popVal, 0);
        labelEl.textContent = 'Population (total in this cell)';
        configEl.classList.add('hidden');
        if (txInfoEl) txInfoEl.classList.add('hidden');
    } else if (mode === 'potential') {
        if (data.potential_no_data) {
            valueEl.textContent = 'No data';
            labelEl.textContent = 'No data available';
        } else if (data.potential_display === 'multiple' && data.potential_no_demand) {
            valueEl.textContent = 'No demand data';
            labelEl.textContent = `Solar Potential / Demand (${getPotentialLevelLabel(data.potential_level)})`;
        } else if (data.potential_display === 'multiple') {
            const ratio = Number.isFinite(data.potential_ratio) ? data.potential_ratio : null;
            valueEl.textContent = ratio === null ? '--' : `${formatNumber(ratio, 2)}×`;
            labelEl.textContent = `Solar Potential / Demand (${getPotentialLevelLabel(data.potential_level)})`;
        } else {
            const val = Number.isFinite(data.potential_twh) ? data.potential_twh : 0;
            valueEl.textContent = `${formatNumber(val, 2)} TWh/yr`;
            labelEl.textContent = `Solar Generation Potential (${getPotentialLevelLabel(data.potential_level)})`;
        }
        configEl.classList.add('hidden');
        if (txInfoEl) txInfoEl.classList.add('hidden');
    }

    panel.classList.remove('hidden');
}

export function updateMap(data, solarGw, battGwh, options = {}) {
    currentMode = 'capacity';
    lastData = data;
    lastDataIsFiltered = options.preFiltered === true;
    lastSolar = solarGw;
    lastBatt = battGwh;
    lastLcoeData = null;
    lastLcoeOptions = null;

    if (selectedMarker) {
        selectedMarker.setStyle({ stroke: false, color: '#fff', weight: 0, radius: 4.5, opacity: 0, fillOpacity: 0 });
        selectedMarker = null;
    }

    resetLayersForMode('capacity');

    const filtered = lastDataIsFiltered ? data : data.filter(d => d.solar_gw === solarGw && d.batt_gwh === battGwh);

    if (!filtered || filtered.length === 0) {
        return;
    }

    if (!capacityPopup) {
        capacityPopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
    }

    if (!capacityMarkersActive && capacityMarkers.size) {
        capacityMarkers.forEach(({ dot, hit }) => {
            dot.addTo(markersLayer);
            hit.addTo(markersLayer);
        });
        capacityMarkersActive = true;
    }

    const activeIds = new Set();
    filtered.forEach(d => {
        const id = d.location_id ?? d._coordKey ?? coordKey(d.latitude, d.longitude);
        activeIds.add(id);

        const color = getColor(d.annual_cf);
        let entry = capacityMarkers.get(id);

        if (!entry) {
            const dot = L.circleMarker([d.latitude, d.longitude], {
                radius: 0.8,
                fillColor: color,
                color: color,
                weight: 0,
                opacity: 1,
                fillOpacity: 0.9,
                pane: 'markers',
                interactive: false,
                renderer: markerRenderer
            });

            const hit = L.circleMarker([d.latitude, d.longitude], {
                radius: 4.5,
                fillColor: '#fff',
                color: '#fff',
                weight: 0,
                opacity: 0,
                fillOpacity: 0,
                pane: 'markers',
                renderer: markerRenderer
            });

            hit.__data = d;

            hit.on('mouseover', () => {
                const row = hit.__data;
                if (!row) return;
                const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">Capacity factor ${(row.annual_cf * 100).toFixed(1)}%</div>
                <div class="text-slate-300">Share of the year a 1&nbsp;MW baseload is met using ${lastSolar} MW_DC solar + ${lastBatt} MWh storage.</div>
             </div>`;
                capacityPopup.setLatLng([row.latitude, row.longitude]).setContent(content).openOn(map);
            });

            hit.on('mouseout', () => {
                map.closePopup(capacityPopup);
            });

            hit.on('click', () => {
                const row = hit.__data;
                if (!row) return;
                if (selectedMarker) {
                    selectedMarker.setStyle({ stroke: false, color: '#fff', weight: 0, radius: 4.5, opacity: 0, fillOpacity: 0 });
                }
                hit.setStyle({ color: '#fff', weight: 2, radius: 6, opacity: 1 });
                selectedMarker = hit;

                const rowColor = getColor(row.annual_cf);
                updateLocationPanel(row, rowColor, 'capacity');

                if (map.onLocationSelect) {
                    map.onLocationSelect(row, 'capacity');
                }
            });

            entry = { dot, hit };
            capacityMarkers.set(id, entry);
            if (activeLayerMode === 'capacity') {
                dot.addTo(markersLayer);
                hit.addTo(markersLayer);
            }
        } else {
            entry.hit.__data = d;
        }

        entry.dot.setStyle({ fillColor: color, color: color, opacity: 1, fillOpacity: 0.9 });
    });

    capacityMarkersActive = true;

    if (capacityMarkers.size !== activeIds.size) {
        capacityMarkers.forEach((entry, id) => {
            const isActive = activeIds.has(id);
            if (!isActive) {
                entry.dot.setStyle({ opacity: 0, fillOpacity: 0 });
                entry.hit.setStyle({ opacity: 0, fillOpacity: 0 });
            } else {
                entry.dot.setStyle({ opacity: 1, fillOpacity: 0.9 });
                entry.hit.setStyle({ opacity: 0, fillOpacity: 0 });
            }
        });
    }

    const mapPoints = filtered.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });
    renderVoronoi(mapPoints, filtered, (row) => getColor(row.annual_cf));
}

export function updatePopulationPolygons(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;
    resetLayersForMode('population');
    markersLayer.clearLayers();

    if (!popData || popData.length === 0 || !geojson) {
        return;
    }

    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeDomain ? buildLcoeScale(lcoeDomain) : null;
    const popIndexByCoord = new Map(popData.map(p => [roundedKey(p.latitude, p.longitude), p]));
    populationScale = buildPopulationScale(popData.map(p => p.population_2020 || 0));

    // Base layer: population grayscale
    const layer = L.geoJSON(geojson, {
        style: (feature) => {
            const props = feature.properties || {};
            const propLat = Number(props.latitude);
            const propLon = Number(props.longitude);
            const centroid = feature.geometry ? L.geoJSON(feature.geometry).getBounds().getCenter() : null;
            const lat = Number.isFinite(propLat) ? propLat : (centroid ? centroid.lat : null);
            const lon = Number.isFinite(propLon) ? propLon : (centroid ? centroid.lng : null);
            const key = (lat !== null && lon !== null) ? roundedKey(lat, lon) : null;
            const popRow = key ? popIndexByCoord.get(key) : null;
            const popVal = popRow?.population_2020 || 0;
            const color = populationScale(popVal);
            return {
                color: color,
                weight: 0.3,
                fillColor: color,
                fillOpacity: 0.85
            };
        },
        onEachFeature: (feature, lyr) => {
            const props = feature.properties || {};
            const propLat = Number(props.latitude);
            const propLon = Number(props.longitude);
            const centroid = feature.geometry ? L.geoJSON(feature.geometry).getBounds().getCenter() : null;
            const lat = Number.isFinite(propLat) ? propLat : (centroid ? centroid.lat : null);
            const lon = Number.isFinite(propLon) ? propLon : (centroid ? centroid.lng : null);
            const key = (lat !== null && lon !== null) ? roundedKey(lat, lon) : null;
            const popRow = key ? popIndexByCoord.get(key) : null;
            const popVal = popRow?.population_2020 || 0;
            const cf = key ? cfByCoord.get(key) : null;
            const cfVal = cf ? cf.annual_cf : null;
            lyr.on('mouseover', (e) => {
                const lcoeLine = overlayMode === 'lcoe' && popRow && Number.isFinite(popRow.lcoe)
                    ? `<div>LCOE: ${formatCurrency(popRow.lcoe, 0)}/MWh</div>` : '';
                const cfLine = cfVal != null ? `<div>Capacity factor: ${(cfVal * 100).toFixed(1)}%</div>` : '';
                const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">Population: ${formatNumber(popVal, 0)}</div>
                    ${lcoeLine}
                    ${cfLine}
                 </div>`;
                const sharedPopup = L.popup({
                    closeButton: false,
                    autoPan: false,
                    className: 'bg-transparent border-none shadow-none'
                });
                sharedPopup.setLatLng(e.latlng).setContent(content).openOn(map);
            });
            lyr.on('mouseout', () => map.closePopup());
            lyr.on('click', () => {
                if (popRow) {
                    const clickLat = Number.isFinite(lyr.getBounds()?.getCenter()?.lat) ? lyr.getBounds().getCenter().lat : (lat ?? popRow.latitude);
                    const clickLon = Number.isFinite(lyr.getBounds()?.getCenter()?.lng) ? lyr.getBounds().getCenter().lng : (lon ?? popRow.longitude);
                    updateLocationPanel({
                        ...popRow,
                        latitude: clickLat,
                        longitude: clickLon,
                        annual_cf: cfVal || 0,
                        population_2020: popVal
                    }, lyr.options.fillColor, 'population');
                    if (map.onLocationSelect) {
                        map.onLocationSelect({ ...popRow, latitude: clickLat, longitude: clickLon, population_2020: popVal }, 'population');
                    }
                }
            });
        }
    });

    layer.addTo(markersLayer);

    // Overlay layer for CF or LCOE with transparency
    if (overlayMode === 'cf' || overlayMode === 'lcoe') {
        const overlayGeo = L.geoJSON(geojson, {
            style: (feature) => {
                const props = feature.properties || {};
                const lat = Number(props.latitude);
                const lon = Number(props.longitude);
                const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
                const cfRow = key ? cfByCoord.get(key) : null;
                const lcoeRow = key ? lcoeByCoord.get(key) : null;
                let color = 'rgba(255,255,255,0)';
                if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
                    color = getColor(cfRow.annual_cf);
                } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
                    color = lcoeScale(lcoeRow.lcoe);
                }
                return {
                    color: color,
                    weight: 0.5,
                    fillColor: color,
                    fillOpacity: 0.35
                };
            },
            interactive: false
        });
        overlayGeo.addTo(overlayLayer);
    }
}

// Re-export capitalRecoveryFactor from utils for backward compatibility
export { crf as capitalRecoveryFactor };

export function updatePopulationSimple(popData, { baseLayer = 'population', overlayMode = 'none', cfData = [], lcoeData = [], lcoeColorInfo = null, targetCf = null, comparisonMetric = 'lcoe', fossilPlants = [], fossilCapacityMap = null, electricityDemandData = [], electricityDemandMap = null, reliabilityData = [], reliabilityMap = null, selectedFuels = [], selectedStatus = 'announced' } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;
    resetLayersForMode('population');
    markersLayer.clearLayers();

    if (!popData || popData.length === 0) return;

    // Build LCOE Map if needed for overlay
    let lcoeMap = null;
    if (overlayMode === 'lcoe' && lcoeData) {
        lcoeMap = new Map(lcoeData.map(d => [d.location_id, d]));
    }

    // Build CF Map if needed
    let cfMap = null;
    if (overlayMode === 'cf' && cfData) {
        cfMap = new Map(cfData.map(d => [d.location_id, d]));
    }

    // Create maps from function parameters for lookup
    const capacityMap = fossilCapacityMap instanceof Map ? fossilCapacityMap : null;
    const demandMap = electricityDemandMap instanceof Map ? electricityDemandMap : null;

    const formatCapacityLines = (cap) => {
        if (!cap || !selectedFuelSet.size) {
            return baseLayer === 'plants' ? '<div class="mt-1 text-slate-500">No installed capacity for the selected fuels.</div>' : '';
        }
        const lines = [];
        selectedFuelSet.forEach(fuel => {
            const value = Number(cap[`${fuel}_mw`] || 0);
            if (value > 0) {
                lines.push(`<div>${capitalizeWord(fuel)}: ${formatNumber(value, 0)} MW</div>`);
            }
        });
        if (!lines.length) {
            return baseLayer === 'plants' ? '<div class="mt-1 text-slate-500">No installed capacity for the selected fuels.</div>' : '';
        }
        return `<div class="mt-1 text-slate-500">Installed capacity<br>${lines.join('')}</div>`;
    };

    const selectedFuelSet = new Set((selectedFuels && selectedFuels.length ? selectedFuels : []).map(f => f.toLowerCase()));
    const popValues = popData.map(p => p.population_2020 || 0);
    const popScale = buildPopulationScale(popValues);

    // Electricity scale (log scale, black to white like population)
    let demandScale = null;
    if (baseLayer === 'electricity' && electricityDemandData && electricityDemandData.length > 0) {
        const demands = electricityDemandData.map(d => d.annual_demand_kwh || 0).filter(v => v > 0);
        if (demands.length > 0) {
            const minD = d3.min(demands);
            const maxD = d3.max(demands);
            // Use same scale as population: interpolateGreys inverted (black = low, white = high)
            demandScale = d3.scaleSequentialLog(t => d3.interpolateGreys(1 - t)).domain([minD, maxD]);
        }
    }

    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeColorInfo ? buildLcoeColorScaleFromInfo(lcoeColorInfo) : null;

    // Build coordinate-based lookup for electricity demand (since popData doesn't have location_id)
    const demandByCoord = new Map();
    if (electricityDemandData && electricityDemandData.length > 0) {
        electricityDemandData.forEach(d => {
            const key = roundedKey(d.latitude, d.longitude);
            demandByCoord.set(key, d);
        });
    }

    // Build coordinate-based lookup for reliability data
    // NOTE: Using 2 decimals because the source voronoi_grid_reliability.csv has 2-decimal precision
    const reliabilityByCoord = new Map();
    if (reliabilityData && reliabilityData.length > 0) {
        reliabilityData.forEach(d => {
            const key = roundedKey(d.latitude, d.longitude, 2);
            reliabilityByCoord.set(key, d);
        });
    }

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    popData.forEach(d => {
        let baseColor = 'rgba(0,0,0,0)';
        let displayPop = true; // default true for population dots

        // Handle Base Layer Color
        if (baseLayer === 'electricity') {
            const demandRow = demandMap && d.location_id != null ? demandMap.get(Number(d.location_id)) : null;
            const val = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
            if (val > 0 && demandScale) {
                baseColor = demandScale(val);
                displayPop = false; // We use voronoi fill for electricity, not dots (or maybe dots?)
            } else {
                baseColor = '#1e293b'; // slate-800 for no data
                displayPop = false;
            }
        } else if (baseLayer === 'plants') {
            // ... existing plant logic handled via dots but we might change visual strategy ...
            // Actually, plant view currently just hides population dots and shows plant voronoi?
            // Let's stick to existing logic:
            // popColor is used for dots.
            displayPop = true;
            // But existing code uses `scale(d.population)`
            baseColor = popScale(d.population_2020 || 0);
        } else {
            // population
            baseColor = popScale(d.population_2020 || 0);
        }

        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);
        const capacity = capacityMap && d.location_id != null ? capacityMap.get(Number(d.location_id)) : null;
        const capacityLines = formatCapacityLines(capacity);

        // Determine overlay color and data
        let overlayColor = null;
        let overlayData = null;
        if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
            overlayColor = getColor(cfRow.annual_cf);
            overlayData = cfRow;
        } else if (overlayMode === 'lcoe' && lcoeScale && lcoeColorInfo && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
            overlayColor = getLcoeColor(lcoeRow, lcoeColorInfo, lcoeScale);
            overlayData = lcoeRow;
        }

        // Dots logic replaced by Voronoi fill for cleaner look in population/electricity mode
        // Only render dots if specifically needed (e.g. maybe for plant mode?)
        // For now, removing dot rendering for base layers to rely on Voronoi.
        /*
        const showDots = (baseLayer === 'population' || baseLayer === 'plants') && overlayMode === 'none';
        if (showDots) {
             L.circleMarker([d.latitude, d.longitude], {
                radius: 0.8,
                fillColor: baseColor,
                color: baseColor,
                weight: 0,
                opacity: 1,
                fillOpacity: 0.9,
                pane: 'markers',
                interactive: false
            }).addTo(markersLayer);
        }
        */

        // key is already defined above at line 598
        const demandRow = demandByCoord.get(key);
        const demandVal = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
        const demandTwh = demandVal / 1e9; // Convert kWh to TWh

        const populationLine = baseLayer === 'population'
            ? `<div class="mt-1 text-slate-400">Population: ${formatNumber(d.population_2020 || 0, 0)}</div>`
            : baseLayer === 'electricity'
                ? `<div class="mt-1 text-slate-400">Annual Demand: ${demandTwh.toFixed(2)} TWh</div>`
                : '';

        const shouldShowHitMarker = true; // Always allow hover for tooltip
        if (shouldShowHitMarker) {
            const marker = L.circleMarker([d.latitude, d.longitude], {
                radius: 4.5,
                fillColor: '#fff',
                color: '#fff',
                weight: 0,
                opacity: 0,
                fillOpacity: 0,
                pane: 'markers',
                renderer: markerRenderer
            });

            marker.on('mouseover', () => {
                let content;
                if (overlayMode === 'lcoe' && overlayData) {
                    const valueLine = overlayData.meetsTarget
                        ? `LCOE: ${overlayData.lcoe ? formatCurrency(overlayData.lcoe) : '--'}/MWh`
                        : `LCOE: ${overlayData.maxConfigLcoe ? `>${formatCurrency(overlayData.maxConfigLcoe)}` : '--'}/MWh`;
                    let infoLines = '';
                    if (overlayData.meetsTarget) {
                        if (lcoeColorInfo?.type === 'tx' && overlayData.txMetrics) {
                            const deltaLine = Number.isFinite(overlayData.delta)
                                ? `<div>Cost delta vs reference: ${overlayData.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(overlayData.delta), 2)}/MWh</div>`
                                : '';
                            const breakevenGw = `${formatCurrency(overlayData.txMetrics.breakevenPerGw / 1000)}/MW`;
                            const breakevenGwKm = `${formatCurrency(overlayData.txMetrics.breakevenPerGwKm / 1000)}/MW/km`;

                            const distanceLine = Number.isFinite(overlayData.txMetrics.distanceKm)
                                ? `<div>Approx. straight-line distance: ${formatNumber(overlayData.txMetrics.distanceKm, 0)} km</div>`
                                : `<div>Approx. straight-line distance: --</div>`;

                            // Cleaned up info lines: Removed redundant savings line, ensures prompt TX cost display
                            infoLines = `${deltaLine}\n<div>Breakeven transmission: ${breakevenGw} (${breakevenGwKm})</div>\n${distanceLine}`;
                        } else if (lcoeColorInfo?.type === 'delta' && Number.isFinite(overlayData.delta)) {
                            infoLines = `<div>Cost delta vs reference: ${overlayData.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(overlayData.delta), 2)}/MWh</div>`;
                        }
                    } else {
                        index = `<div class="text-amber-300">Target CF for 1&nbsp;MW baseload not met in this dataset.</div>`;
                        infoLines += `<div>Highest config (${overlayData.maxConfigSolar ?? '--'} MW_DC, ${overlayData.maxConfigBatt ?? '--'} MWh)</div>`;
                    }
                    content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">${valueLine}</div>
                    <div>CF ${(overlayData.annual_cf * 100).toFixed(1)}% | Solar ${overlayData.solar_gw} MW_DC | Battery ${overlayData.batt_gwh} MWh</div>
                    ${infoLines}
                    ${populationLine}
                    ${capacityLines}
                 </div>`;
                } else if (overlayMode === 'cf' && overlayData) {
                    content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">CF: ${(overlayData.annual_cf * 100).toFixed(1)}%</div>
                    ${populationLine}
                    ${capacityLines}
                 </div>`;
                } else if (overlayMode === 'access' || baseLayer === 'access') {
                    // Access mode - show reliability (use 2 decimals for lookup)
                    const relKey = roundedKey(d.latitude, d.longitude, 2);
                    const relData = reliabilityByCoord.get(relKey);

                    const hasData = relData && relData.hrea_covered;
                    const hreaCovered = relData ? (relData.hrea_covered ? 'Yes' : 'No') : '--';

                    let metricLine = '';
                    if (hasData) {
                        const relVal = (relData.avg_reliability_access_only || 0).toFixed(1) + '%';
                        const noAccessVal = ((relData.pct_no_access || 0) * 100).toFixed(1) + '%';

                        // Highlight the active metric
                        if (currentAccessMetric === 'no_access') {
                            metricLine = `<div class="font-semibold">No Access: ${noAccessVal}</div>
                                           <div class="text-slate-400 text-[10px]">Grid Reliability (connected): ${relVal}</div>`;
                        } else {
                            metricLine = `<div class="font-semibold">Grid Reliability: ${relVal}</div>
                                           <div class="text-slate-400 text-[10px]">No Access: ${noAccessVal}</div>`;
                        }
                    } else {
                        metricLine = `<div class="font-semibold">Average Grid Uptime: No Data</div>`;
                    }

                    content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    ${metricLine}
                    <div class="text-slate-400">HREA Data Available: ${hreaCovered}</div>
                    ${populationLine}
                    ${capacityLines}
                 </div>`;
                } else {
                    const baseInfo = populationLine || '<div class="mt-1 text-slate-400">Installed capacity summary:</div>';
                    content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    ${baseInfo}
                    ${capacityLines}
                 </div>`;
                }
                sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
            });

            marker.on('mouseout', () => {
                map.closePopup(sharedPopup);
            });

            marker.on('click', () => {
                if (selectedMarker) {
                    selectedMarker.setStyle({ stroke: false, color: '#000', weight: 1, radius: 4 });
                }
                marker.setStyle({ color: '#fff', weight: 2, radius: 6 });
                selectedMarker = marker;

                updateLocationPanel({
                    ...d,
                    ...(overlayData || {}),
                    population_2020: d.population_2020,
                    targetCf,
                    comparisonMetric
                }, overlayColor || baseColor, overlayMode === 'lcoe' ? 'lcoe' : overlayMode === 'cf' ? 'capacity' : 'population');

                if (map.onLocationSelect) {
                    map.onLocationSelect({ ...d, ...overlayData, population_2020: d.population_2020 }, overlayMode === 'lcoe' ? 'lcoe' : overlayMode === 'cf' ? 'capacity' : 'population');
                }
            });

            marker.addTo(markersLayer);
        }
    });

    const filteredPlants = baseLayer === 'plants' && Array.isArray(fossilPlants)
        ? fossilPlants.filter(plant => selectedFuelSet.has(plant.fuel_group) && plant.status === selectedStatus)
        : [];

    if (filteredPlants.length) {
        const plantPopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
        filteredPlants.forEach(plant => {
            if (!Number.isFinite(plant.latitude) || !Number.isFinite(plant.longitude)) return;
            const color = FOSSIL_COLORS[plant.fuel_group] || '#e2e8f0';
            const baseCapacity = Number.isFinite(plant.capacity_mw) ? Math.max(plant.capacity_mw, 0) : 0;
            const radius = Math.max(2, Math.min(12, Math.sqrt(baseCapacity) * 0.15));
            const marker = L.circleMarker([plant.latitude, plant.longitude], {
                radius,
                fillColor: color,
                color,
                weight: 0,
                opacity: 1,
                fillOpacity: 0.3,
                pane: 'markers',
                renderer: markerRenderer
            });
            marker.on('mouseover', () => {
                const cap = formatNumber(baseCapacity, 0);
                const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">${plant.plant_name || 'Power plant'}</div>
                    <div>${plant.fuel_group.toUpperCase()} • ${cap} MW</div>
                    <div class="text-slate-300">${capitalizeWord(plant.status)}</div>
                    <div class="text-slate-400">${plant.country || 'Unknown'}</div>
                 </div>`;
                plantPopup.setLatLng([plant.latitude, plant.longitude]).setContent(content).openOn(map);
            });
            marker.on('mouseout', () => map.closePopup(plantPopup));
            marker.addTo(overlayLayer);
        });
    }

    const voronoiPoints = popData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });

    // Define base layer fill function (demand layer)
    const baseFill = (d) => {
        if (baseLayer === 'access') {
            // Use coordinate-based lookup with 2 decimals to match source data
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const rel = reliabilityByCoord.get(relKey);

            if (!rel) return '#334155'; // No record found -> Slate 700
            if (!rel.hrea_covered) return '#334155'; // No HREA coverage -> Slate 700 (No Data)

            // Determine value based on metric
            let val = 0;
            if (currentAccessMetric === 'no_access') {
                // High no access (1.0) -> Bad (Red). Low no access (0.0) -> Good (Green).
                // Scale expects 0->Red, 100->Green.
                // Map: 1 - pct (0..1) -> 0..1 * 100 -> 0..100.
                val = (1 - (rel.pct_no_access || 0)) * 100;
            } else {
                // Reliability: 0->Red (Low), 100->Green (High)
                // Use access_only metric if available, else standard
                val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            }

            // Scale 0-100 -> color (Red low, Yellow mid, Green high)
            return d3.scaleLinear()
                .domain(ACCESS_COLOR_SCALE.domain)
                .range(ACCESS_COLOR_SCALE.range)
                (val);
        } else if (baseLayer === 'electricity') {
            const key = roundedKey(d.latitude, d.longitude);
            const demandRow = demandByCoord.get(key);
            const val = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
            if (val > 0 && demandScale) {
                return demandScale(val);
            }
            return '#1e293b'; // slate-800 for no data
        } else if (baseLayer === 'population' || baseLayer === 'plants') {
            const popVal = d.population_2020 || 0;
            return popScale(popVal);
        }
        return 'rgba(0,0,0,0)';
    };

    // Define overlay fill function (supply layer)
    const overlayFill = overlayMode !== 'none' ? (d) => {
        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);

        if (overlayMode === 'access') {
            const rel = reliabilityByCoord.get(key);
            if (!rel) return '#334155';
            if (!rel.hrea_covered) return '#334155'; // No Data

            // Determine value based on metric
            let val = 0;
            if (currentAccessMetric === 'no_access') {
                val = (1 - (rel.pct_no_access || 0)) * 100;
            } else {
                val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            }

            // Scale 0-100 -> color (Red low, Yellow mid, Green high)
            return d3.scaleLinear()
                .domain(ACCESS_COLOR_SCALE.domain)
                .range(ACCESS_COLOR_SCALE.range)
                (val);
        } else if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
            return getColor(cfRow.annual_cf);
        } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
            return getLcoeColor(lcoeRow, lcoeColorInfo, lcoeScale);
        }
        return null; // null means no overlay color for this cell
    } : null;

    // Use dual-layer rendering to show both demand and supply with transparency
    renderVoronoiDual(voronoiPoints, popData, baseFill, overlayFill);
}

function renderVoronoiDual(mapPoints, data, baseFill, overlayFill) {
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll("*").remove();

    if (mapPoints.length <= 1) return;

    const hasBase = typeof baseFill === 'function';
    const hasOverlay = typeof overlayFill === 'function';
    if (!hasBase && !hasOverlay) return;

    let path = null;
    if (worldGeoJSON) {
        const transform = d3.geoTransform({
            point: function (x, y) {
                const point = map.latLngToLayerPoint(new L.LatLng(y, x));
                this.stream.point(point.x, point.y);
            },
        });
        path = d3.geoPath().projection(transform);

        svg.select("defs").remove();
        const defs = svg.append("defs");
        defs
            .append("clipPath")
            .attr("id", "clip-land")
            .append("path")
            .datum(worldGeoJSON)
            .attr("d", path);
    }

    const clip = worldGeoJSON ? "url(#clip-land)" : null;
    const size = map.getSize();
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const delaunay = d3.Delaunay.from(mapPoints);
    const voronoi = delaunay.voronoi(bounds);

    // When both layers are present, use lower opacity so overlap is visible
    const baseOpacity = hasOverlay ? 0.5 : 0.85;
    const overlayOpacity = hasBase ? 0.5 : 0.35;

    if (hasBase) {
        const base = svg.append("g").attr("clip-path", clip);
        base
            .selectAll("path")
            .data(data)
            .enter()
            .append("path")
            .attr("d", (_, i) => voronoi.renderCell(i))
            .attr("fill", d => baseFill ? baseFill(d) : "#111827")
            .attr("fill-opacity", baseOpacity)
            .attr("stroke", "rgba(255,255,255,0.08)")
            .attr("stroke-width", 0.5)
            .attr("class", "transition-color")
            .style("pointer-events", "none");
    }

    if (hasOverlay) {
        svg
            .append("g")
            .attr("clip-path", clip)
            .selectAll("path")
            .data(data)
            .enter()
            .append("path")
            .attr("d", (_, i) => voronoi.renderCell(i))
            .attr("fill", d => overlayFill(d) || "rgba(0,0,0,0)")
            .attr("fill-opacity", overlayOpacity)
            .attr("stroke", "none")
            .attr("class", "transition-color")
            .style("pointer-events", "none");
    }
}

export function updatePopulationGeo(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;
    resetLayersForMode('population');
    markersLayer.clearLayers();

    if (!popData || popData.length === 0 || !geojson) return;

    const popByCoord = new Map(popData.map(p => [roundedKey(p.latitude, p.longitude), p.population_2020 || 0]));
    const scale = buildPopulationScale(popData.map(p => p.population_2020 || 0));
    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeDomain ? buildLcoeScale(lcoeDomain) : null;

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    const layer = L.geoJSON(geojson, {
        style: (feature) => {
            const props = feature.properties || {};
            const lat = Number(props.latitude);
            const lon = Number(props.longitude);
            const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
            const popVal = key ? popByCoord.get(key) || 0 : 0;
            const color = scale(popVal);
            return {
                color: color,
                weight: 0.3,
                fillColor: color,
                fillOpacity: 0.85
            };
        },
        onEachFeature: (feature, lyr) => {
            const props = feature.properties || {};
            const lat = Number(props.latitude);
            const lon = Number(props.longitude);
            const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
            const popVal = key ? popByCoord.get(key) || 0 : 0;
            lyr.on('mouseover', (e) => {
                const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">Population: ${formatNumber(popVal, 0)}</div>
                 </div>`;
                sharedPopup.setLatLng(e.latlng).setContent(content).openOn(map);
            });
            lyr.on('mouseout', () => map.closePopup());
            lyr.on('click', () => {
                const center = lyr.getBounds().getCenter();
                const clickLat = Number.isFinite(center?.lat) ? center.lat : lat;
                const clickLon = Number.isFinite(center?.lng) ? center.lng : lon;
                updateLocationPanel({
                    latitude: clickLat,
                    longitude: clickLon,
                    population_2020: popVal,
                    annual_cf: 0
                }, lyr.options.fillColor, 'population');
                if (map.onLocationSelect) {
                    map.onLocationSelect({ latitude: clickLat, longitude: clickLon, population_2020: popVal }, 'population');
                }
            });
        }
    });

    layer.addTo(markersLayer);

    // Overlay layer on top of population
    if (overlayMode === 'cf' || overlayMode === 'lcoe') {
        const overlay = L.geoJSON(geojson, {
            style: (feature) => {
                const props = feature.properties || {};
                const lat = Number(props.latitude);
                const lon = Number(props.longitude);
                const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
                const cfRow = key ? cfByCoord.get(key) : null;
                const lcoeRow = key ? lcoeByCoord.get(key) : null;
                let color = 'rgba(0,0,0,0)';
                let hasData = false;
                if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
                    color = getColor(cfRow.annual_cf);
                    hasData = true;
                } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
                    color = lcoeScale(lcoeRow.lcoe);
                    hasData = true;
                }
                return {
                    color: hasData ? color : 'rgba(0,0,0,0)',
                    weight: 0,
                    fillColor: hasData ? color : 'rgba(0,0,0,0)',
                    fillOpacity: hasData ? 0.35 : 0
                };
            },
            interactive: false
        });
        overlay.addTo(overlayLayer);
    }
}

export function updatePotentialMap(potentialData, { level = 'level1', min = null, max = null, displayMode = 'total', demandMap = null, latBounds = null } = {}) {
    currentMode = 'potential';
    selectedMarker = null;

    resetLayersForMode('potential');
    markersLayer.clearLayers();

    if (!potentialData || potentialData.length === 0) return;

    const key = level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const isMultiple = displayMode === 'multiple';
    const values = potentialData.map(d => Number(d[key] || 0)).filter(v => Number.isFinite(v));
    const scaleMin = Number.isFinite(min) ? min : (values.length ? Math.min(...values) : 0);
    const scaleMax = Number.isFinite(max) ? max : (values.length ? Math.max(...values) : 1);
    const noDataColor = '#6b7280';

    const totalInterpolator = d3.interpolateRgbBasis(POTENTIAL_TOTAL_COLORS);
    const colorScale = isMultiple
        ? (val) => {
            const value = Number.isFinite(val) ? val : 0;
            for (const bucket of POTENTIAL_MULTIPLE_BUCKETS) {
                if (bucket.max === null || value < bucket.max) {
                    return bucket.color;
                }
            }
            return POTENTIAL_MULTIPLE_BUCKETS[POTENTIAL_MULTIPLE_BUCKETS.length - 1].color;
        }
        : d3.scaleSequential(totalInterpolator)
            .domain([scaleMin, scaleMax])
            .clamp(true);

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    potentialData.forEach(d => {
        const total = Number(d[key] || 0);
        const lat = Number(d.latitude);
        let ratio = null;
        let demandTwh = null;
        const noData = latBounds
            ? (!Number.isFinite(lat) || lat < latBounds.min || lat > latBounds.max)
            : false;
        let noDemand = false;
        if (isMultiple) {
            const demandRow = demandMap ? demandMap.get(d.location_id) : null;
            const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
            demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
            ratio = demandTwh > 0 ? total / demandTwh : null;
            noDemand = demandTwh <= 0;
        }
        const displayValue = isMultiple ? (ratio ?? 0) : total;
        const color = noData || (isMultiple && noDemand)
            ? noDataColor
            : colorScale(displayValue || 0);

        // Visual marker
        L.circleMarker([d.latitude, d.longitude], {
            radius: 0.8,
            fillColor: color,
            color: color,
            weight: 0,
            opacity: 1,
            fillOpacity: 0.9,
            pane: 'markers',
            interactive: false,
            renderer: markerRenderer
        }).addTo(markersLayer);

        const marker = L.circleMarker([d.latitude, d.longitude], {
            radius: 6,
            fillColor: '#fff',
            color: '#fff',
            weight: 0,
            opacity: 0,
            fillOpacity: 0,
            pane: 'markers',
            renderer: markerRenderer
        });

        marker.on('mouseover', () => {
            let mainLine = '';
            let demandLine = '';
            if (noData) {
                mainLine = 'No data available';
            } else if (isMultiple && noDemand) {
                mainLine = 'No demand data available';
            } else if (isMultiple) {
                mainLine = `Solar Potential / Demand: ${ratio !== null ? `${formatNumber(ratio, 2)}×` : '--'}`;
                demandLine = `<div class="text-slate-300">Demand: ${demandTwh ? `${formatNumber(demandTwh, 2)} TWh/yr` : '0 TWh/yr'}</div>`;
            } else {
                mainLine = `Solar Generation Potential: ${formatNumber(total, 2)} TWh/yr`;
            }
            const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">${mainLine}</div>
                ${demandLine}
                <div class="text-slate-300">${getPotentialLevelLabel(level)} • Assumed ${formatNumber(d.assumed_mw_per_km2, 0)} MW/km²</div>
            </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            if (selectedMarker) {
                selectedMarker.setStyle({ stroke: false, color: '#000', weight: 1, radius: 4 });
            }
            marker.setStyle({ color: '#fff', weight: 2, radius: 6 });
            selectedMarker = marker;

            updateLocationPanel({
                ...d,
                potential_twh: total,
                potential_ratio: ratio,
                demand_twh: demandTwh,
                potential_level: level,
                potential_display: displayMode,
                potential_no_data: noData,
                potential_no_demand: noDemand
            }, color, 'potential');

            if (map.onLocationSelect) {
                map.onLocationSelect({
                    ...d,
                    potential_twh: total,
                    potential_ratio: ratio,
                    demand_twh: demandTwh,
                    potential_level: level,
                    potential_display: displayMode,
                    potential_no_data: noData,
                    potential_no_demand: noDemand
                }, 'potential');
            }
        });

        marker.addTo(markersLayer);
    });

    const mapPoints = potentialData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });

    renderVoronoi(mapPoints, potentialData, (row) => {
        const totalVal = Number(row[key] || 0);
        const latVal = Number(row.latitude);
        if (latBounds && (!Number.isFinite(latVal) || latVal < latBounds.min || latVal > latBounds.max)) {
            return noDataColor;
        }
        let value = totalVal;
        if (isMultiple) {
            const demandRow = demandMap ? demandMap.get(row.location_id) : null;
            const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
            const demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
            if (demandTwh <= 0) return noDataColor;
            value = totalVal / demandTwh;
        }
        return colorScale(value || 0);
    }, { enableHoverSelect: false });
}

export function updateLcoeMap(bestData, options = {}) {
    currentMode = 'lcoe';
    lastLcoeData = bestData;
    lastLcoeOptions = options;
    selectedMarker = null;
    resetLayersForMode('lcoe');
    markersLayer.clearLayers();

    if (!bestData || bestData.length === 0) {
        return;
    }

    const targetCf = options.targetCf || null;
    const colorInfo = options.colorInfo || { type: 'lcoe', domain: null };
    const reference = options.reference || null;
    const metricMode = options.comparisonMetric || 'lcoe';

    const colorScale = buildLcoeColorScaleFromInfo(colorInfo);

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    bestData.forEach(d => {
        let color = '#611010'; // default for missing/non-target cells (deep red)
        if (d.meetsTarget) {
            color = getLcoeColor(d, colorInfo, colorScale);
        }

        // Visual marker
        L.circleMarker([d.latitude, d.longitude], {
            radius: 0.8,
            fillColor: color,
            color: color,
            weight: 0,
            opacity: 1,
            fillOpacity: 0.9,
            pane: 'markers',
            interactive: false,
            renderer: markerRenderer
        }).addTo(markersLayer);

        // Hit marker
        const marker = L.circleMarker([d.latitude, d.longitude], {
            radius: 4.5,
            fillColor: '#fff',
            color: '#fff',
            weight: 0,
            opacity: 0,
            fillOpacity: 0,
            pane: 'markers',
            renderer: markerRenderer
        });

        marker.on('mouseover', () => {
            let infoLines = '';
            if (d.meetsTarget) {
                if (reference) {
                    const deltaLine = Number.isFinite(d.delta)
                        ? `<div>Cost delta vs reference: ${d.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(d.delta), 2)}/MWh</div>`
                        : '';
                    const txMetrics = d.txMetrics;
                    const breakevenGw = txMetrics ? `${formatCurrency(txMetrics.breakevenPerGw / 1000)}/MW` : '--';
                    const breakevenGwKm = txMetrics ? `${formatCurrency(txMetrics.breakevenPerGwKm / 1000)}/MW/km` : '--';

                    const distanceLine = txMetrics && Number.isFinite(txMetrics.distanceKm)
                        ? `<div>Approx. straight-line distance: ${formatNumber(txMetrics.distanceKm, 0)} km</div>`
                        : `<div>Approx. straight-line distance: --</div>`;

                    // Cleaned up info lines: Removed redundant savings line, ensures prompt TX cost display
                    infoLines = `${deltaLine}
<div>Breakeven transmission: ${breakevenGw} (${breakevenGwKm})</div>
${distanceLine}`;
                } else if (Number.isFinite(d.delta)) {
                    infoLines = `<div>Cost delta vs reference: ${d.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(d.delta), 2)}/MWh</div>`;
                }
            } else {
                const maxText = d.maxConfigLcoe ? `>${formatCurrency(d.maxConfigLcoe)}/MWh` : '--';
                infoLines = `<div class="text-amber-300">Target CF for 1&nbsp;MW baseload not met in this dataset.</div>
                    <div>Highest config (${d.maxConfigSolar ?? '--'} MW_DC, ${d.maxConfigBatt ?? '--'} MWh): ${maxText}</div>`;
            }
            const valueLine = d.meetsTarget
                ? `LCOE: ${d.lcoe ? formatCurrency(d.lcoe) : '--'}/MWh`
                : `LCOE: ${d.maxConfigLcoe ? `>${formatCurrency(d.maxConfigLcoe)}` : '--'}/MWh`;
            const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">${valueLine}</div>
                <div>CF ${(d.annual_cf * 100).toFixed(1)}% (share of year 1&nbsp;MW met) | Solar ${d.solar_gw} MW_DC | Battery ${d.batt_gwh} MWh</div>
                ${infoLines}
             </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            if (selectedMarker) {
                selectedMarker.setStyle({ stroke: false, color: '#000', weight: 1, radius: 4 });
            }
            marker.setStyle({ color: '#fff', weight: 2, radius: 6 });
            selectedMarker = marker;

            updateLocationPanel({ ...d, targetCf, comparisonMetric: metricMode }, color, 'lcoe');

            if (map.onLocationSelect) {
                map.onLocationSelect({ ...d, targetCf }, 'lcoe');
            }
        });

        // Highlight reference if present
        if (reference && reference.location_id === d.location_id) {
            marker.setStyle({ color: '#f59e0b', weight: 3, radius: 6, opacity: 1 });
            selectedMarker = marker;
        }

        marker.addTo(markersLayer);
    });

    // Refresh location panel for reference so deltas stay current
    if (reference) {
        const refRow = bestData.find(r => r.location_id === reference.location_id);
        if (refRow) {
            const color = getLcoeColor(refRow, colorInfo, colorScale);
            updateLocationPanel({ ...refRow, targetCf, comparisonMetric: metricMode }, color, 'lcoe');
        }
    }

    const mapPoints = bestData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });
    renderVoronoi(
        mapPoints,
        bestData,
        (row) => getLcoeColor(row, colorInfo, colorScale),
        { enableHoverSelect: false }
    );
}

// Similar to updateLcoeMap but for CF display (Target LCOE mode)
export function updateCfMap(cfData, options = {}) {
    currentMode = 'lcoe_cf'; // Use distinct mode for Target Mode (CF Map)
    lastCfData = cfData;
    lastCfOptions = options;
    selectedMarker = null;
    resetLayersForMode('lcoe_cf');
    markersLayer.clearLayers();

    if (!cfData || cfData.length === 0) {
        return;
    }

    const targetLcoe = options.targetLcoe || null;
    const colorInfo = options.colorInfo || { type: 'cf', domain: [0, 0.5, 1] };
    const reference = options.reference || null;

    const colorScale = buildLcoeColorScaleFromInfo(colorInfo);

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    cfData.forEach(d => {
        // Use d.meetsTarget if present, otherwise default to true (legacy safe)
        const meetsTarget = d.meetsTarget !== false;
        const color = getLcoeColor({ ...d, lcoe: d.cf, meetsTarget }, colorInfo, colorScale);

        // Visual marker
        L.circleMarker([d.latitude, d.longitude], {
            radius: 0.8,
            fillColor: color,
            color: color,
            weight: 0,
            opacity: 1,
            fillOpacity: 0.9,
            pane: 'markers',
            interactive: false,
            renderer: markerRenderer
        }).addTo(markersLayer);

        // Hit marker
        const marker = L.circleMarker([d.latitude, d.longitude], {
            radius: 4.5,
            fillColor: '#fff',
            color: '#fff',
            weight: 0,
            opacity: 0,
            fillOpacity: 0,
            pane: 'markers',
            renderer: markerRenderer
        });

        marker.on('mouseover', () => {
            let infoLines = '';
            if (meetsTarget) {
                if (reference && Number.isFinite(d.delta)) {
                    const deltaSign = d.delta >= 0 ? '+' : '';
                    infoLines = `<div>CF delta vs reference: ${deltaSign}${(d.delta * 100).toFixed(1)}%</div>`;
                }
            } else {
                infoLines = `<div class="text-amber-300">Target LCOE not met.</div>
                    <div>Lowest LCOE config:</div>`;
            }

            const cfPercent = (d.cf * 100).toFixed(1);
            const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">CF: ${meetsTarget ? cfPercent + '%' : '--'}</div>
                <div>Solar ${d.solar_gw} MW_DC | Battery ${d.batt_gwh} MWh</div>
                <div>LCOE: ${formatCurrency(d.lcoe)}/MWh</div>
                ${infoLines}
             </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            if (selectedMarker) {
                selectedMarker.setStyle({ stroke: false, color: '#000', weight: 1, radius: 4 });
            }
            marker.setStyle({ color: '#fff', weight: 2, radius: 6 });
            selectedMarker = marker;

            updateLocationPanel({ ...d, targetLcoe, meetsTarget }, color, 'lcoe');

            if (map.onLocationSelect) {
                map.onLocationSelect({ ...d, targetLcoe, meetsTarget }, 'lcoe');
            }
        });

        // Highlight reference if present
        if (reference && reference.location_id === d.location_id) {
            marker.setStyle({ color: '#f59e0b', weight: 3, radius: 6, opacity: 1 });
            selectedMarker = marker;
        }

        marker.addTo(markersLayer);
    });

    // Refresh location panel for reference
    if (reference) {
        const refRow = cfData.find(r => r.location_id === reference.location_id);
        if (refRow) {
            const meetsTarget = refRow.meetsTarget !== false;
            const color = getLcoeColor({ ...refRow, lcoe: refRow.cf, meetsTarget }, colorInfo, colorScale);
            updateLocationPanel({ ...refRow, targetLcoe, meetsTarget }, color, 'lcoe');
        }
    }

    const mapPoints = cfData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });

    renderVoronoi(
        mapPoints,
        cfData,
        (row) => {
            const meetsTarget = row.meetsTarget !== false;
            return getLcoeColor({ ...row, lcoe: row.cf, meetsTarget }, colorInfo, colorScale);
        },
        { enableHoverSelect: false }
    );
}

function renderVoronoi(mapPoints, data, fillAccessor, options = {}) {
    const { enableHoverSelect = true } = options;
    const hasClickHandler = typeof options.onClick === 'function';
    const allowPointerEvents = enableHoverSelect || hasClickHandler;
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll("*").remove();

    // If only one point, just a circle
    if (mapPoints.length === 1) {
        // ... (simplified for now, or just skip)
        return;
    }

    if (worldGeoJSON) {
        const transform = d3.geoTransform({
            point: function (x, y) {
                const point = map.latLngToLayerPoint(new L.LatLng(y, x));
                this.stream.point(point.x, point.y);
            },
        });
        const path = d3.geoPath().projection(transform);

        // Remove existing defs to avoid duplicates/stale clips
        svg.select("defs").remove();

        const defs = svg.append("defs");
        defs
            .append("clipPath")
            .attr("id", "clip-land")
            .append("path")
            .datum(worldGeoJSON)
            .attr("d", path);
    }

    const g = svg.append("g")
        .attr("class", "voronoi-group")
        .attr("clip-path", worldGeoJSON ? "url(#clip-land)" : null);
    g.style("pointer-events", allowPointerEvents ? "all" : "none");

    const delaunay = d3.Delaunay.from(mapPoints);
    const size = map.getSize();
    // Add buffer to cover the whole map view
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const voronoi = delaunay.voronoi(bounds);

    g.selectAll("path")
        .data(data)
        .enter()
        .append("path")
        .attr("d", (_, i) => voronoi.renderCell(i))
        .each(function (d) {
            const el = d3.select(this);
            const style = fillAccessor ? fillAccessor(d) : null;
            if (style && typeof style === 'object') {
                el.attr("fill", style.fillColor || style.color)
                    .attr("fill-opacity", Number.isFinite(style.fillOpacity) ? style.fillOpacity : 0.6)
                    .attr("stroke", style.color || "rgba(255,255,255,0.08)")
                    .attr("stroke-width", Number.isFinite(style.weight) ? style.weight : 0.5);
            } else {
                el.attr("fill", style || getColor(d.annual_cf))
                    .attr("fill-opacity", 0.6)
                    .attr("stroke", "rgba(255,255,255,0.08)")
                    .attr("stroke-width", 0.5);
            }
        })
        .attr("class", "transition-color")
        .style("pointer-events", allowPointerEvents ? "all" : "none")
        .on("click", (e, d) => {
            if (options.onClick) {
                options.onClick(d);
            }
        })
        .on("mouseover", (e, d) => {
            if (!enableHoverSelect) return;
            markersLayer.eachLayer(layer => {
                if (!layer.getLatLng) return;
                const latLng = layer.getLatLng();
                if (Math.abs(latLng.lat - d.latitude) < 0.0001 && Math.abs(latLng.lng - d.longitude) < 0.0001) {
                    layer.fire('click');
                }
            });
        })
        .on("mouseout", () => {
            // Optional: clear selection if desired, or leave it
        });
}

// ========== SAMPLE DAYS FUNCTIONS ==========

function getDominanceColor(source) {
    switch (source) {
        case 's': return '#facc15'; // yellow - solar
        case 'b': return '#a855f7'; // purple - battery
        default: return '#9ca3af';  // gray - other
    }
}

export function updateMapWithSampleFrame(frameData) {
    currentMode = 'samples';
    lastSampleFrame = frameData;
    if (!frameData || !frameData.locations) {
        console.warn('No frame data provided');
        return;
    }

    const { locations } = frameData;
    if (locations.length === 0) {
        return;
    }
    const modeChanged = resetLayersForMode('samples', { preserveVoronoi: true });
    if (modeChanged) {
        lastSampleVoronoiKey = null;
        sampleMarkersActive = false;
    }

    if (!samplePopup) {
        samplePopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
    }

    if (!sampleMarkersActive && sampleMarkers.size) {
        sampleMarkers.forEach(({ dot, hit }) => {
            dot.addTo(markersLayer);
            hit.addTo(markersLayer);
        });
        sampleMarkersActive = true;
    }

    // Add markers with dominance colors
    const activeIds = new Set();
    locations.forEach(loc => {
        const color = loc.color;
        const id = loc.location_id ?? coordKey(loc.latitude, loc.longitude);
        activeIds.add(id);

        let entry = sampleMarkers.get(id);
        if (!entry) {
            const dot = L.circleMarker([loc.latitude, loc.longitude], {
                radius: 0.8,
                fillColor: color,
                color: color,
                weight: 0,
                opacity: 1,
                fillOpacity: 0.9,
                pane: 'markers',
                interactive: false,
                renderer: markerRenderer
            });

            const hit = L.circleMarker([loc.latitude, loc.longitude], {
                radius: 6,
                fillColor: '#fff',
                color: '#fff',
                weight: 0,
                opacity: 0,
                fillOpacity: 0,
                pane: 'markers',
                renderer: markerRenderer
            });

            hit.on('mouseover', () => {
                const info = hit.__sampleInfo;
                if (!info) return;
                const solar = Number.isFinite(info.solarShare) ? (info.solarShare * 100).toFixed(1) : '--';
                const battery = Number.isFinite(info.batteryShare) ? (info.batteryShare * 100).toFixed(1) : '--';
                const other = Number.isFinite(info.otherShare) ? (info.otherShare * 100).toFixed(1) : '--';
                const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">Generation mix</div>
                    <div class="text-[11px] text-slate-300">Solar: ${solar}%</div>
                    <div class="text-[11px] text-slate-300">Battery: ${battery}%</div>
                    <div class="text-[11px] text-slate-300">Other: ${other}%</div>
                </div>`;
                samplePopup.setLatLng([info.latitude, info.longitude]).setContent(content).openOn(map);
                hit.setStyle({ color: '#f59e0b', weight: 2, radius: 8, opacity: 1 });
            });
            hit.on('mouseout', () => {
                map.closePopup(samplePopup);
                hit.setStyle({ color: '#fff', weight: 0, radius: 6, opacity: 0 });
            });
            hit.on('click', () => {
                if (sampleLocationHandler && hit.__sampleInfo) {
                    sampleLocationHandler({ ...hit.__sampleInfo });
                }
            });

            entry = { dot, hit };
            sampleMarkers.set(id, entry);
            if (activeLayerMode === 'samples') {
                dot.addTo(markersLayer);
                hit.addTo(markersLayer);
            }
        }

        entry.dot.setStyle({ fillColor: color, color: color, opacity: 1, fillOpacity: 0.9 });
        entry.hit.__sampleInfo = {
            location_id: loc.location_id,
            latitude: loc.latitude,
            longitude: loc.longitude,
            solarShare: loc.solarShare ?? 0,
            batteryShare: loc.batteryShare ?? 0,
            otherShare: loc.otherShare ?? 0
        };
    });

    sampleMarkersActive = true;

    if (sampleMarkers.size !== activeIds.size) {
        sampleMarkers.forEach((entry, id) => {
            if (!activeIds.has(id)) {
                markersLayer.removeLayer(entry.dot);
                markersLayer.removeLayer(entry.hit);
                sampleMarkers.delete(id);
            }
        });
    }

    // Render Voronoi background
    if (locations.length > 0) {
        const viewKey = `${map.getZoom()}|${map.getCenter().lat.toFixed(4)},${map.getCenter().lng.toFixed(4)}|${map.getSize().x}x${map.getSize().y}`;
        const locationsKey = `${locations.length}|${locations[0]?.location_id ?? ''}|${locations[locations.length - 1]?.location_id ?? ''}`;
        const voronoiKey = `${viewKey}|${locationsKey}`;

        if (lastSampleVoronoiKey === voronoiKey && updateSampleVoronoiColors(locations)) {
            // Colors updated without rebuilding geometry.
        } else {
            const mapPoints = locations.map(loc => {
                const point = map.latLngToLayerPoint([loc.latitude, loc.longitude]);
                return [point.x, point.y];
            });
            renderSampleVoronoi(mapPoints, locations);
            lastSampleVoronoiKey = voronoiKey;
        }
    }
}

function renderSampleVoronoi(mapPoints, locations) {
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll("*").remove();

    if (mapPoints.length === 1) {
        return;
    }

    if (worldGeoJSON) {
        const transform = d3.geoTransform({
            point: function (x, y) {
                const point = map.latLngToLayerPoint(new L.LatLng(y, x));
                this.stream.point(point.x, point.y);
            },
        });
        const path = d3.geoPath().projection(transform);

        const defs = svg.append("defs");
        defs
            .append("clipPath")
            .attr("id", "clip-land")
            .append("path")
            .datum(worldGeoJSON)
            .attr("d", path);
    }

    const g = svg.append("g")
        .attr("class", "sample-voronoi")
        .attr("clip-path", worldGeoJSON ? "url(#clip-land)" : null);

    const delaunay = d3.Delaunay.from(mapPoints);
    const size = map.getSize();
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const voronoi = delaunay.voronoi(bounds);

    g.selectAll("path")
        .data(locations, d => d.location_id)
        .enter()
        .append("path")
        .attr("d", (_, i) => voronoi.renderCell(i))
        .attr("fill", d => d.color)
        .attr("fill-opacity", 0.6)
        .attr("stroke", "rgba(255,255,255,0.08)")
        .attr("stroke-width", 0.5)
        .style("transition", "fill 0.9s ease")
        .style("pointer-events", "none");
}

function updateSampleVoronoiColors(locations) {
    const svg = d3.select(voronoiLayer._container);
    const group = svg.select(".sample-voronoi");
    if (group.empty()) return false;
    group.selectAll("path")
        .data(locations, d => d.location_id)
        .attr("fill", d => d.color);
    return true;
}

export function setSampleLocationClickHandler(handler) {
    sampleLocationHandler = handler;
    sampleMarkers.forEach(entry => {
        const marker = entry.hit;
        marker.off('click');
        if (handler && marker.__sampleInfo) {
            marker.on('click', () => handler({ ...marker.__sampleInfo }));
        }
    });
}
// ========== SUBSET MAP FUNCTIONS ==========

export let subsetMap;
let subsetVoronoiLayer;

export async function initSubsetMap() {
    if (subsetMap) {
        setTimeout(() => subsetMap.invalidateSize(), 100);
        return;
    }

    const container = document.getElementById('subset-map');
    if (!container) return;

    subsetMap = L.map('subset-map', {
        zoomControl: false,
        attributionControl: false,
        zoomAnimation: false,  // Disable zoom animation to prevent SVG scale mismatch
        fadeAnimation: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false
    }).setView([20, 0], 2);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(subsetMap);

    subsetMap.createPane('voronoi');
    subsetMap.getPane('voronoi').style.zIndex = 400;

    subsetVoronoiLayer = L.svg({ pane: 'voronoi' }).addTo(subsetMap);
}

export function renderSubsetMap(allData, subsetIds, getValue, getColor, layerType = 'population', getRadius = null, getTooltip = null, onPointHover = null, onPointOut = null) {
    if (!subsetMap || !subsetVoronoiLayer) return;

    // Clear existing
    const svg = d3.select(subsetVoronoiLayer._container);
    svg.selectAll("*").remove();

    if (!allData || allData.length === 0) return;

    // Common setup
    const size = subsetMap.getSize();
    const subsetSet = new Set(subsetIds);

    const draw = () => {
        try {
            // Clear ALL SVG contents to prevent stale elements on zoom/pan
            svg.selectAll("*").remove();

            const size = subsetMap.getSize(); // update size in draw
            if (size.x === 0 || size.y === 0) {
                console.warn('[SubsetMap] Skipping draw - size is zero');
                return;
            }

            // Check if we have data to render
            if (!allData || allData.length === 0) {
                console.warn('[SubsetMap] Skipping draw - no data');
                return;
            }

            // Map points to pixel coords

            if (layerType === 'plants') {
                // Render Points (Circles)
                const subsetData = allData.filter(d => subsetSet.has(d.location_id));

                const circles = svg.selectAll("circle")
                    .data(subsetData)
                    .enter()
                    .append("circle")
                    .attr("cx", d => subsetMap.latLngToLayerPoint([d.latitude, d.longitude]).x)
                    .attr("cy", d => subsetMap.latLngToLayerPoint([d.latitude, d.longitude]).y)
                    .attr("r", d => getRadius ? getRadius(d) : 4)
                    .attr("fill", d => getColor(getValue(d)))
                    .attr("fill-opacity", 0.3)
                    .attr("stroke", "none")
                    .attr("stroke-width", 0)
                    .style("pointer-events", "auto");

                if (onPointHover || onPointOut) {
                    circles
                        .on("mouseover", (e, d) => onPointHover && onPointHover(e, d))
                        .on("mouseout", (e, d) => onPointOut && onPointOut(e, d));
                } else {
                    circles.append("title")
                        .text(d => getTooltip ? getTooltip(d) : `Value: ${formatNumber(getValue(d), 2)}`);
                }

            } else {
                // Render Voronoi (Clipped)

                // 1. Setup Clip Path
                const transform = d3.geoTransform({
                    point: function (x, y) {
                        const point = subsetMap.latLngToLayerPoint(new L.LatLng(y, x));
                        this.stream.point(point.x, point.y);
                    },
                });
                const path = d3.geoPath().projection(transform);

                if (worldGeoJSON) {
                    const defs = svg.append("defs");
                    defs.append("clipPath")
                        .attr("id", "clip-land-subset")
                        .append("path")
                        .datum(worldGeoJSON)
                        .attr("d", path);
                }

                const buffer = Math.max(size.x, size.y);
                const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];

                const points = allData.map(d => {
                    const p = subsetMap.latLngToLayerPoint([d.latitude, d.longitude]);
                    return [p.x, p.y];
                });

                const delaunay = d3.Delaunay.from(points);
                const voronoi = delaunay.voronoi(bounds);

                // Pre-filter data indices for the subset
                const pathsData = [];
                allData.forEach((d, i) => {
                    if (subsetSet.has(d.location_id)) {
                        pathsData.push({ d, i });
                    }
                });

                // 2. Render paths with clip-path
                svg.append("g")
                    .attr("clip-path", worldGeoJSON ? "url(#clip-land-subset)" : null)
                    .selectAll("path")
                    .data(pathsData)
                    .enter()
                    .append("path")
                    .attr("d", p => voronoi.renderCell(p.i))
                    .attr("fill", p => getColor(getValue(p.d)))
                    .attr("fill-opacity", 0.9)
                    .attr("stroke", "none")
                    .style("pointer-events", "auto")
                    .append("title")
                    .text(p => {
                        const val = getValue(p.d);
                        return `Value: ${formatNumber(val, 2)}`;
                    });
            }
        } catch (e) {
            console.error('[SubsetMap] Error in draw:', e);
        }
    };

    draw();

    // update on move/resize/zoom - need all these for proper SVG sync
    subsetMap.off('moveend');
    subsetMap.off('resize');
    subsetMap.off('zoomend');
    subsetMap.off('viewreset');
    subsetMap.off('zoom');

    subsetMap.on('moveend', draw);
    subsetMap.on('resize', draw);
    subsetMap.on('zoomend', draw);
    subsetMap.on('viewreset', draw);
    subsetMap.on('zoom', draw);
}
