
let map;
let markersLayer;
let overlayLayer;
let voronoiLayer;
let selectedMarker = null;
let sampleMarkers = new Map();
let currentMode = 'capacity';
let sampleLocationHandler = null;
let populationOverlay = false;
let populationData = null;
let populationScale = null;
const ALL_FOSSIL_FUELS = ['coal','gas','oil'];

// Helper function
function capitalizeWord(str = '') {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// Color scale for Capacity Factor (0.0 to 1.0)
const colorScale = d3.scaleLinear()
    .domain([0, 0.05, 0.4, 0.7, 1.0])
    .range(["#0049ff", "#0049ff", "#00c853", "#ff9800", "#d32f2f"])
    .interpolate(d3.interpolateRgb)
    .clamp(true);

function getColor(cf) {
    return colorScale(cf);
}

const FOSSIL_COLORS = {
    coal: '#f97316',
    gas: '#38bdf8',
    oil: '#f43f5e'
};

function buildPopulationScale(values) {
    const valid = values.filter(Number.isFinite);
    const min = valid.length ? Math.min(...valid) : 0;
    const max = valid.length ? Math.max(...valid) : 1;
    return d3.scaleLinear()
        .domain([min, max])
        .range(["#111827", "#f3f4f6"])
        .clamp(true);
}

function buildLcoeScale(domain) {
    const defaultDomain = [50, 120, 220, 320];
    const scaleDomain = Array.isArray(domain) && domain.length >= 3 ? domain.slice() : defaultDomain;
    // Ensure strictly increasing values to satisfy d3
    for (let i = 1; i < scaleDomain.length; i++) {
        if (scaleDomain[i] <= scaleDomain[i - 1]) {
            scaleDomain[i] = scaleDomain[i - 1] + 1;
        }
    }
    const range = scaleDomain.length === 4
        ? ["#0ea5e9", "#22c55e", "#eab308", "#ef4444"]
        : ["#22c55e", "#eab308", "#ef4444"];
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
    return buildLcoeScale(colorInfo.domain);
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

export async function initMap(onLocationSelect) {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false
    }).setView([20, 0], 2); // World view

    // Dark Matter basemap
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(map);

    L.control.zoom({ position: 'topright' }).addTo(map);

    map.createPane('markers');
    map.getPane('markers').style.zIndex = 600;

    markersLayer = L.layerGroup().addTo(map);
    overlayLayer = L.layerGroup().addTo(map);
    voronoiLayer = L.svg().addTo(map);

    // Re-render Voronoi on move
    map.on('moveend', () => {
        if (currentMode === 'capacity' && lastData && lastSolar !== null && lastBatt !== null) {
            updateMap(lastData, lastSolar, lastBatt);
        } else if (currentMode === 'lcoe' && lastLcoeData) {
            updateLcoeMap(lastLcoeData, lastLcoeOptions || {});
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
        labelEl.textContent = 'Annual Capacity Factor (share of the year 1 GW baseload is met)';
        configEl.classList.remove('hidden');
        if (configTextEl) {
            configTextEl.textContent = `Solar ${lastSolar} GW_DC • Battery ${lastBatt} GWh powering a steady 1 GW baseload.`;
        }
        if (txInfoEl) {
            txInfoEl.classList.add('hidden');
        }
    } else if (mode === 'lcoe') {
        const targetText = data.targetCf ? `target ${(data.targetCf * 100).toFixed(0)}% CF for 1 GW baseload` : 'target CF for 1 GW baseload';
        const deltaText = Number.isFinite(data.delta)
            ? ` (Δ ${data.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(data.delta), 1)}/MWh vs reference)`
            : '';
        if (data.meetsTarget) {
            valueEl.textContent = data.lcoe ? `${formatCurrency(data.lcoe)}/MWh` : '--';
            labelEl.textContent = `Best LCOE meeting ${targetText}${deltaText}`;
        } else {
            const maxText = data.maxConfigLcoe ? `>${formatCurrency(data.maxConfigLcoe)}/MWh` : '--';
            valueEl.textContent = maxText;
            labelEl.textContent = 'Target CF not met for 1 GW requirement in this region';
        }
        configEl.classList.remove('hidden');
        if (configTextEl) {
            if (data.meetsTarget) {
                configTextEl.textContent = `Solar ${data.solar_gw} GW_DC • Battery ${data.batt_gwh} GWh serving 1 GW baseload.`;
            } else {
                const solar = data.maxConfigSolar ?? data.solar_gw;
                const batt = data.maxConfigBatt ?? data.batt_gwh;
                configTextEl.textContent = `Highest config: Solar ${solar ?? '--'} GW_DC • Battery ${batt ?? '--'} GWh`;
            }
        }
        if (txInfoEl) {
            if (data.meetsTarget && data.txMetrics && data.txMetrics.breakevenPerGw > 0) {
                txInfoEl.classList.remove('hidden');
                if (txMwhEl) {
                    txMwhEl.textContent = `${formatCurrency(data.txMetrics.savingsPerMwh, 2)}/MWh`;
                }
                if (txGwKmEl) {
                    txGwKmEl.textContent = `${formatCurrency(data.txMetrics.breakevenPerGwKm)}/GW/km`;
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
    }

    panel.classList.remove('hidden');
}

export function updateMap(data, solarGw, battGwh) {
    currentMode = 'capacity';
    lastData = data;
    lastSolar = solarGw;
    lastBatt = battGwh;
    lastLcoeData = null;
    lastLcoeOptions = null;
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

    // Filter data for current config
    console.log(`Filtering for Solar: ${solarGw} (type: ${typeof solarGw}), Batt: ${battGwh} (type: ${typeof battGwh})`);
    const filtered = data.filter(d => d.solar_gw === solarGw && d.batt_gwh === battGwh);
    console.log("Filtered rows:", filtered.length);

    if (filtered.length === 0 && data.length > 0) {
        console.log("Sample row solar_gw type:", typeof data[0].solar_gw);
    }

    if (filtered.length === 0) {
        document.getElementById('stat-avg-cf').textContent = '--%';
        document.getElementById('stat-max-cf').textContent = '--%';
        return;
    }
    const cfs = filtered.map(d => d.annual_cf);
    const avg = cfs.reduce((a, b) => a + b, 0) / cfs.length;
    const max = Math.max(...cfs);

    // Update stats in UI
    document.getElementById('stat-avg-cf').textContent = (avg * 100).toFixed(1) + '%';
    document.getElementById('stat-max-cf').textContent = (max * 100).toFixed(1) + '%';

    // Shared popup
    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none' // Custom styling handled in content
    });

    // Add markers
    // Optimization: Use CircleMarkers for performance
    filtered.forEach(d => {
        const color = getColor(d.annual_cf);

        // Visual marker (small dot)
        L.circleMarker([d.latitude, d.longitude], {
            radius: 0.8,
            fillColor: color,
            color: color,
            weight: 0,
            opacity: 1,
            fillOpacity: 0.9,
            pane: 'markers',
            interactive: false // Visual only
        }).addTo(markersLayer);

        // Hit marker (larger invisible target)
        const marker = L.circleMarker([d.latitude, d.longitude], {
            radius: 4.5,
            fillColor: '#fff', // Color doesn't matter, it's invisible
            color: '#fff',
            weight: 0,
            opacity: 0,
            fillOpacity: 0,
            pane: 'markers'
        });

        marker.on('mouseover', () => {
            const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">Capacity factor ${(d.annual_cf * 100).toFixed(1)}%</div>
                <div class="text-slate-300">Share of the year a 1&nbsp;GW baseload is met using ${lastSolar} GW_DC solar + ${lastBatt} GWh storage.</div>
             </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            // Highlight selection
            if (selectedMarker) {
                selectedMarker.setStyle({ stroke: false, color: '#000', weight: 1, radius: 4 });
            }
            marker.setStyle({ color: '#fff', weight: 2, radius: 6 });
            selectedMarker = marker;

            // Update UI
            updateLocationPanel(d, color, 'capacity');

            // Trigger callback
            if (map.onLocationSelect) {
                map.onLocationSelect(d, 'capacity');
            }
        });

        marker.addTo(markersLayer);
    });

    // Render Voronoi
    if (filtered.length > 0) {
        const mapPoints = filtered.map(d => {
            const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
            return [point.x, point.y];
        });
        renderVoronoi(mapPoints, filtered, (row) => getColor(row.annual_cf));
    }
}

export function updatePopulationPolygons(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

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

function capitalRecoveryFactor(rate, years) {
    if (years <= 0) return 0;
    if (rate === 0) return 1 / years;
    const pow = Math.pow(1 + rate, years);
    return (rate * pow) / (pow - 1);
}

function formatNumber(value, decimals = 0) {
    if (!Number.isFinite(value)) return '--';
    return value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

function formatCurrency(value, decimals = 0) {
    const num = formatNumber(value, decimals);
    return num === '--' ? '--' : `$${num}`;
}

function coordKey(lat, lon) {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function roundedKey(lat, lon, decimals = 4) {
    return `${lat.toFixed(decimals)},${lon.toFixed(decimals)}`;
}

export function updatePopulationSimple(popData, { baseLayer = 'population', overlayMode = 'none', cfData = [], lcoeData = [], lcoeColorInfo = null, targetCf = null, comparisonMetric = 'lcoe', fossilPlants = [], fossilCapacityMap = null, selectedFuels = ALL_FOSSIL_FUELS } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

    if (!popData || popData.length === 0) return;

    const capacityMap = fossilCapacityMap instanceof Map ? fossilCapacityMap : null;
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

    const selectedFuelSet = new Set((selectedFuels && selectedFuels.length ? selectedFuels : ALL_FOSSIL_FUELS).map(f => f.toLowerCase()));
    const popValues = popData.map(p => p.population_2020 || 0);
    const scale = buildPopulationScale(popValues);
    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeColorInfo ? buildLcoeColorScaleFromInfo(lcoeColorInfo) : null;

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    popData.forEach(d => {
        const popColor = scale(d.population_2020 || 0);
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

        const showPopulationDots = baseLayer === 'population' && overlayMode === 'none';
        if (showPopulationDots) {
            L.circleMarker([d.latitude, d.longitude], {
                radius: 0.8,
                fillColor: popColor,
                color: popColor,
                weight: 0,
                opacity: 1,
                fillOpacity: 0.9,
                pane: 'markers',
                interactive: false
            }).addTo(markersLayer);
        }
        // No dots for CF or LCOE overlays - only Voronoi cells

        const populationLine = baseLayer === 'population'
            ? `<div class="mt-1 text-slate-400">Population: ${formatNumber(d.population_2020 || 0, 0)}</div>`
            : '';
        const shouldShowHitMarker = baseLayer === 'population' || overlayMode !== 'none';
        if (shouldShowHitMarker) {
            const marker = L.circleMarker([d.latitude, d.longitude], {
                radius: 4.5,
                fillColor: '#fff',
                color: '#fff',
                weight: 0,
                opacity: 0,
                fillOpacity: 0,
                pane: 'markers'
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
                        const breakevenGw = `${formatCurrency(overlayData.txMetrics.breakevenPerGw)}/GW`;
                        const breakevenGwKm = `${formatCurrency(overlayData.txMetrics.breakevenPerGwKm)}/GW/km`;
                        const savingsLine = overlayData.txMetrics.savingsPerMwh > 0
                            ? `<div>Captured savings: ${formatCurrency(overlayData.txMetrics.savingsPerMwh, 2)}/MWh @ CF ${(overlayData.annual_cf * 100).toFixed(1)}%</div>`
                            : '';
                        const distanceLine = Number.isFinite(overlayData.txMetrics.distanceKm)
                            ? `<div>Approx. straight-line distance: ${formatNumber(overlayData.txMetrics.distanceKm, 0)} km</div>`
                            : `<div>Approx. straight-line distance: --</div>`;
                        infoLines = `${deltaLine}
                            <div>Breakeven transmission: ${breakevenGw} (${breakevenGwKm})</div>
                            ${savingsLine}
                            ${distanceLine}`;
                    } else if (lcoeColorInfo?.type === 'delta' && Number.isFinite(overlayData.delta)) {
                        infoLines = `<div>Cost delta vs reference: ${overlayData.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(overlayData.delta), 2)}/MWh</div>`;
                    }
                } else {
                    infoLines += `<div class="text-amber-300">Target CF for 1&nbsp;GW baseload not met in this dataset.</div>`;
                    infoLines += `<div>Highest config (${overlayData.maxConfigSolar ?? '--'} GW_DC, ${overlayData.maxConfigBatt ?? '--'} GWh)</div>`;
                }
                content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">${valueLine}</div>
                    <div>CF ${(overlayData.annual_cf * 100).toFixed(1)}% | Solar ${overlayData.solar_gw} GW_DC | Battery ${overlayData.batt_gwh} GWh</div>
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
                }, overlayColor || popColor, overlayMode === 'lcoe' ? 'lcoe' : overlayMode === 'cf' ? 'capacity' : 'population');

                if (map.onLocationSelect) {
                    map.onLocationSelect({ ...d, ...overlayData, population_2020: d.population_2020 }, overlayMode === 'lcoe' ? 'lcoe' : overlayMode === 'cf' ? 'capacity' : 'population');
                }
            });

            marker.addTo(markersLayer);
        }
    });

    const filteredPlants = baseLayer === 'plants' && Array.isArray(fossilPlants)
        ? fossilPlants.filter(plant => selectedFuelSet.has(plant.fuel_group))
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
                pane: 'markers'
            });
            marker.on('mouseover', () => {
                const cap = formatNumber(baseCapacity, 0);
                const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">${plant.plant_name || 'Power plant'}</div>
                    <div>${plant.fuel_group.toUpperCase()} • ${cap} MW</div>
                    <div class="text-slate-400">${plant.country || 'Unknown'}</div>
                 </div>`;
                plantPopup.setLatLng([plant.latitude, plant.longitude]).setContent(content).openOn(map);
            });
            marker.on('mouseout', () => map.closePopup(plantPopup));
            marker.addTo(overlayLayer);
        });
    }

    const mapPoints = popData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });

    const overlayAccessor = (row) => {
        const key = roundedKey(row.latitude, row.longitude);
        if (overlayMode === 'cf') {
            const cfRow = cfByCoord.get(key);
            if (cfRow && Number.isFinite(cfRow.annual_cf)) return getColor(cfRow.annual_cf);
        } else if (overlayMode === 'lcoe' && lcoeScale && lcoeColorInfo) {
            const lRow = lcoeByCoord.get(key);
            if (lRow && Number.isFinite(lRow.lcoe)) return getLcoeColor(lRow, lcoeColorInfo, lcoeScale);
        }
        return null;
    };

    const renderBasePolygons = baseLayer === 'population';
    const renderOverlay = overlayMode !== 'none';
    if (renderBasePolygons || renderOverlay) {
        renderVoronoiDual(
            mapPoints,
            popData,
            renderBasePolygons ? (row => scale(row.population_2020 || 0)) : null,
            renderOverlay ? overlayAccessor : null
        );
    }
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

    if (hasBase) {
        const base = svg.append("g").attr("clip-path", clip);
        base
            .selectAll("path")
            .data(data)
            .enter()
            .append("path")
            .attr("d", (_, i) => voronoi.renderCell(i))
            .attr("fill", d => baseFill ? baseFill(d) : "#111827")
            .attr("fill-opacity", 0.85)
            .attr("stroke", "rgba(255,255,255,0.08)")
            .attr("stroke-width", 0.5)
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
            .attr("fill-opacity", 0.35)
            .attr("stroke", "none")
            .style("pointer-events", "none");
    }
}

export function updatePopulationGeo(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

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

export function updateLcoeMap(bestData, options = {}) {
    currentMode = 'lcoe';
    lastLcoeData = bestData;
    lastLcoeOptions = options;
    selectedMarker = null;

    markersLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

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
            interactive: false
        }).addTo(markersLayer);

        // Hit marker
        const marker = L.circleMarker([d.latitude, d.longitude], {
            radius: 4.5,
            fillColor: '#fff',
            color: '#fff',
            weight: 0,
            opacity: 0,
            fillOpacity: 0,
            pane: 'markers'
        });

        marker.on('mouseover', () => {
            let infoLines = '';
            if (d.meetsTarget) {
                if (reference) {
                    const deltaLine = Number.isFinite(d.delta)
                        ? `<div>Cost delta vs reference: ${d.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(d.delta), 2)}/MWh</div>`
                        : '';
                    const txMetrics = d.txMetrics;
                    const breakevenGw = txMetrics ? `${formatCurrency(txMetrics.breakevenPerGw)}/GW` : '--';
                    const breakevenGwKm = txMetrics ? `${formatCurrency(txMetrics.breakevenPerGwKm)}/GW/km` : '--';
                    const savingsLine = txMetrics && txMetrics.savingsPerMwh > 0
                        ? `<div>Captured savings: ${formatCurrency(txMetrics.savingsPerMwh, 2)}/MWh @ CF ${(d.annual_cf * 100).toFixed(1)}%</div>`
                        : '';
                    const distanceLine = txMetrics && Number.isFinite(txMetrics.distanceKm)
                        ? `<div>Approx. straight-line distance: ${formatNumber(txMetrics.distanceKm, 0)} km</div>`
                        : `<div>Approx. straight-line distance: --</div>`;
                    infoLines = `${deltaLine}
                        <div>Breakeven transmission: ${breakevenGw} (${breakevenGwKm})</div>
                        ${savingsLine}
                        ${distanceLine}`;
                } else if (Number.isFinite(d.delta)) {
                    infoLines = `<div>Cost delta vs reference: ${d.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(d.delta), 2)}/MWh</div>`;
                }
            } else {
                const maxText = d.maxConfigLcoe ? `>${formatCurrency(d.maxConfigLcoe)}/MWh` : '--';
                infoLines = `<div class="text-amber-300">Target CF for 1&nbsp;GW baseload not met in this dataset.</div>
                    <div>Highest config (${d.maxConfigSolar ?? '--'} GW_DC, ${d.maxConfigBatt ?? '--'} GWh): ${maxText}</div>`;
            }
            const valueLine = d.meetsTarget
                ? `LCOE: ${d.lcoe ? formatCurrency(d.lcoe) : '--'}/MWh`
                : `LCOE: ${d.maxConfigLcoe ? `>${formatCurrency(d.maxConfigLcoe)}` : '--'}/MWh`;
            const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">${valueLine}</div>
                <div>CF ${(d.annual_cf * 100).toFixed(1)}% (share of year 1&nbsp;GW met) | Solar ${d.solar_gw} GW_DC | Battery ${d.batt_gwh} GWh</div>
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

function renderVoronoi(mapPoints, data, fillAccessor, options = {}) {
    const { enableHoverSelect = true } = options;
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
    g.style("pointer-events", "none");

    const delaunay = d3.Delaunay.from(mapPoints);
    const size = map.getSize();
    // Add buffer to cover the whole map view
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const voronoi = delaunay.voronoi(bounds);

    svg.append("g")
        .attr("clip-path", worldGeoJSON ? "url(#clip-land)" : null)
        .selectAll("path")
        .data(data)
        .enter()
        .append("path")
        .attr("d", (_, i) => voronoi.renderCell(i))
        .attr("fill", d => fillAccessor ? fillAccessor(d) : getColor(d.annual_cf))
        .attr("fill-opacity", 0.6)
        .attr("stroke", "rgba(255,255,255,0.08)")
        .attr("stroke-width", 0.5)
        .style("pointer-events", "all")
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

    // Clear existing visual layers
    markersLayer.clearLayers();
    sampleMarkers.clear();

    const samplePopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    // Add markers with dominance colors
    locations.forEach(loc => {
        const color = loc.color;

        // Visual marker (thin dot)
        L.circleMarker([loc.latitude, loc.longitude], {
            radius: 0.8,
            fillColor: color,
            color: color,
            weight: 0,
            opacity: 1,
            fillOpacity: 0.9,
            pane: 'markers',
            interactive: false
        }).addTo(markersLayer);

        // Interactive hit target for hover/click
        const hitMarker = L.circleMarker([loc.latitude, loc.longitude], {
            radius: 6,
            fillColor: '#fff',
            color: '#fff',
            weight: 0,
            opacity: 0,
            fillOpacity: 0,
            pane: 'markers'
        });
        hitMarker.__sampleInfo = {
            location_id: loc.location_id,
            latitude: loc.latitude,
            longitude: loc.longitude,
            solarShare: loc.solarShare ?? 0,
            batteryShare: loc.batteryShare ?? 0,
            otherShare: loc.otherShare ?? 0
        };
        hitMarker.on('mouseover', () => {
            const info = hitMarker.__sampleInfo;
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
            hitMarker.setStyle({ color: '#f59e0b', weight: 2, radius: 8, opacity: 1 });
        });
        hitMarker.on('mouseout', () => {
            map.closePopup(samplePopup);
            hitMarker.setStyle({ color: '#fff', weight: 0, radius: 6, opacity: 0 });
        });
        hitMarker.on('click', () => {
            if (sampleLocationHandler) {
                sampleLocationHandler({ ...hitMarker.__sampleInfo });
            }
        });
        hitMarker.addTo(markersLayer);
        sampleMarkers.set(loc.location_id, hitMarker);
    });

    // Render Voronoi background
    if (locations.length > 0) {
        const mapPoints = locations.map(loc => {
            const point = map.latLngToLayerPoint([loc.latitude, loc.longitude]);
            return [point.x, point.y];
        });

        renderSampleVoronoi(mapPoints, locations);
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
        .attr("class", "voronoi-group")
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

export function setSampleLocationClickHandler(handler) {
    sampleLocationHandler = handler;
    sampleMarkers.forEach(marker => {
        marker.off('click');
        if (handler && marker.__sampleInfo) {
            marker.on('click', () => handler({ ...marker.__sampleInfo }));
        }
    });
}
