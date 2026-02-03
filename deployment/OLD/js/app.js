import { loadSummary, loadPopulationCsv, loadVoronoiGeojson, loadFossilPlantsCsv, loadVoronoiFossilCapacityCsv } from './data.js';
import { initMap, updateMap, updateLcoeMap, updatePopulationSimple } from './map.js';
import { initSampleDays, loadSampleWeekData, cleanupSampleDays } from './samples.js';

// State
let summaryData = [];
let currentSolar = 5;
let currentBatt = 8;
let currentLocationId = null;
let currentViewMode = 'capacity';
let locationIndex = new Map();
let lcoeResults = [];
let populationData = [];
let summaryCoordIndex = new Map();
let populationCoordIndex = new Map();
let voronoiGeojson = null;
let fossilPlants = [];
let fossilCapacity = [];
let fossilCapacityMap = new Map();
const BASE_LOAD_MW = 1000; // assume baseload of 1 GW for CF outputs
const ALL_FUELS = ['coal', 'gas', 'oil'];
const TX_WACC = 0.06;
const TX_LIFE = 50;
const TX_CRF = (() => {
    // capitalRecoveryFactor is hoisted, so safe to call later
    try {
        return capitalRecoveryFactor ? capitalRecoveryFactor(TX_WACC, TX_LIFE) : 0;
    } catch {
        return 0;
    }
})();
let lcoeParams = {
    solarCapex: 600,       // $/kW_DC
    batteryCapex: 120,     // $/kWh
    solarOpexPct: 0.015,   // 1.5% of capex annually
    batteryOpexPct: 0.02,  // 2% of capex annually (as requested)
    solarLife: 30,
    batteryLife: 20,
    wacc: 0.07,
    targetCf: 0.90
};
let lcoeUpdateTimeout = null;
let lcoeReference = null; // Stores the selected location's LCOE result
const DELTA_PERCENTILE = 0.95;
let comparisonMetric = 'lcoe';
let legendLock = false;
let lockedColorInfo = null;
let lastColorInfo = null;
const VIEW_MODE_EXPLANATIONS = {
    capacity: 'Capacity Factor Map shows what share of the year a given solar + storage build can sustain a 1\u00a0GW baseload.',
    samples: 'Hourly Profile Samples replay a representative 168-hour week so you can examine solar output, storage dispatch, and any unmet 1\u00a0GW demand.',
    lcoe: 'LCOE Map compares the levelized cost ($/MWh) of every location that can meet the target capacity factor.',
    population: 'Supply-Demand Matching links where people live (population density as a proxy for demand) with the CF or LCOE of each location.'
};

// DOM Elements
const solarSlider = document.getElementById('solar-slider');
const battSlider = document.getElementById('batt-slider');
const solarVal = document.getElementById('solar-val');
const battVal = document.getElementById('batt-val');
const loading = document.getElementById('loading');
const loadingStatus = document.getElementById('loading-status');
const viewModeSelect = document.getElementById('view-mode');
const viewModeExplainer = document.getElementById('view-mode-explainer');
const configNote = document.getElementById('config-note');
const statsSection = document.getElementById('stats-section');
const sampleControls = document.getElementById('sample-controls');
const locationPanel = document.getElementById('location-panel');
const systemConfig = document.getElementById('system-config');
const legendCapacity = document.getElementById('legend-capacity');
const legendSamples = document.getElementById('legend-samples');
const legendLcoe = document.getElementById('legend-lcoe');
const statsMetrics = document.getElementById('stats-metrics');
const legendLcoeTitle = document.getElementById('legend-lcoe-title');
const legendLcoeMin = document.getElementById('legend-lcoe-min');
const legendLcoeMid = document.getElementById('legend-lcoe-mid');
const legendLcoeMax = document.getElementById('legend-lcoe-max');
const legendLcoeRef = document.getElementById('legend-lcoe-ref');
const legendLcoeBar = document.getElementById('legend-lcoe-bar');
const legendLcoeNoData = document.getElementById('legend-lcoe-no-data');
const LCOE_NO_DATA_COLOR = '#611010';
const legendTxExplainer = document.getElementById('legend-tx-explainer');
const comparisonToggle = document.getElementById('comparison-toggle');
const comparisonButtons = document.querySelectorAll('#comparison-toggle button');
const clearRefBtn = document.getElementById('lcoe-clear-ref');
const legendLockBtn = document.getElementById('legend-lock-btn');
const lcoeControls = document.getElementById('lcoe-controls');
const targetCfSlider = document.getElementById('target-cf-slider');
const targetCfVal = document.getElementById('target-cf-val');
const solarCapexInput = document.getElementById('solar-capex');
const batteryCapexInput = document.getElementById('battery-capex');
const solarOpexInput = document.getElementById('solar-opex');
const batteryOpexInput = document.getElementById('battery-opex');
const solarLifeInput = document.getElementById('solar-life');
const batteryLifeInput = document.getElementById('battery-life');
const waccInput = document.getElementById('wacc');
const populationOverlayButtons = document.querySelectorAll('#population-overlay-mode button');
const populationBaseButtons = document.querySelectorAll('#population-base-toggle button');
const populationFuelButtons = document.querySelectorAll('#population-fuel-filter button');
const populationFuelFilterWrapper = document.getElementById('population-fuel-filter');
const populationToggleWrapper = document.getElementById('population-toggle');
const populationOverlaySelectWrapper = document.getElementById('population-overlay-select-wrapper');
const populationOverlayConfig = document.getElementById('population-overlay-config');
const populationSolarSlider = document.getElementById('population-solar-slider');
const populationSolarVal = document.getElementById('population-solar-val');
const populationBattSlider = document.getElementById('population-batt-slider');
const populationBattVal = document.getElementById('population-batt-val');
const populationDisplayToggle = document.getElementById('population-display-toggle');
const populationDisplayButtons = document.querySelectorAll('#population-display-toggle button');
const legendPopulation = document.getElementById('legend-population');
const legendPopMin = document.getElementById('legend-pop-min');
const legendPopMax = document.getElementById('legend-pop-max');
const legendPopLayerNote = document.getElementById('legend-pop-layer-note');
const legendFossilPlants = document.getElementById('legend-fossil-plants');
const populationLcoeWrapper = document.getElementById('population-lcoe-controls-wrapper');
const populationOverlayHelper = document.getElementById('population-overlay-helper');
const populationViewHelper = document.getElementById('population-view-helper');
const populationChartsCta = document.getElementById('population-charts-cta');
const mapContainer = document.getElementById('map');
const populationChartsContainer = document.getElementById('population-charts');
const populationChartHistogram = document.getElementById('population-chart-histogram');
const populationChartLatMetric = document.getElementById('population-chart-lat-metric');
const populationChartLatPop = document.getElementById('population-chart-lat-pop');
const populationChartHistogramTitle = document.getElementById('population-chart-histogram-title');
const populationChartHistogramLabel = document.getElementById('population-chart-histogram-label');
const populationChartMetricLabel = document.getElementById('population-chart-metric-label');
const populationChartLatMetricTitle = document.getElementById('population-chart-lat-metric-title');
const populationChartLatPopLabel = document.getElementById('population-chart-lat-pop-label');
const populationChartLatPopHelper = document.getElementById('population-chart-lat-pop-helper');
const populationChartLayerButtons = document.querySelectorAll('#population-chart-layer-toggle button');
const populationChartOverlayButtons = document.querySelectorAll('#population-chart-overlay-toggle button');
const populationChartMetricButtons = document.querySelectorAll('#population-chart-metric-toggle button');
const viewModeChartSelect = document.getElementById('view-mode-chart');
const locCoordsEl = document.getElementById('loc-coords');
const locValueEl = document.getElementById('loc-value');
const locLabelEl = document.getElementById('loc-label');
const locConfigEl = document.getElementById('loc-config');
const locConfigTextEl = document.getElementById('loc-config-text');
const locTxInfoEl = document.getElementById('loc-tx-info');

// Store original parent of LCOE controls for moving back and forth
let lcoeControlsOriginalParent = null;
let lcoeControlsOriginalNextSibling = null;

let populationDisplayMode = 'map';
let populationCharts = {
    histogram: null,
    latMetric: null,
    latPop: null,
    metric: null
};
let populationChartMetric = 'cf';
let populationBaseLayer = 'population';
let populationOverlayMode = 'none';
let populationFuelFilter = new Set(['coal', 'gas', 'oil']);
let locationPanelShowingChartSummary = false;

// Helpers
function buildLocationIndex(data) {
    const index = new Map();
    data.forEach(row => {
        const arr = index.get(row.location_id) || [];
        arr.push(row);
        index.set(row.location_id, arr);
    });
    return index;
}

function buildCoordIndex(data) {
    const index = new Map();
    data.forEach(row => {
        if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) return;
        const key = coordKey(row.latitude, row.longitude);
        index.set(key, row);
    });
    return index;
}

function capitalizeWord(str = '') {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function describeFuelSelection(set) {
    if (!set || set.size === 0 || set.size === ALL_FUELS.length) return 'fossil';
    if (set.size === 1) return Array.from(set)[0];
    return 'selected fossil';
}

function capitalRecoveryFactor(rate, years) {
    if (years <= 0) return 0;
    if (rate === 0) return 1 / years;
    const pow = Math.pow(1 + rate, years);
    return (rate * pow) / (pow - 1);
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => deg * Math.PI / 180;
    const R = 6371; // Earth radius in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function coordKey(lat, lon) {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function computeConfigLcoe(row, params) {
    const solarKw = row.solar_gw * 1_000_000;      // GW_DC -> kW
    const batteryKwh = row.batt_gwh * 1_000_000;   // GWh -> kWh

    const solarCapex = params.solarCapex * solarKw;
    const batteryCapex = params.batteryCapex * batteryKwh;

    const solarAnnual = solarCapex * capitalRecoveryFactor(params.wacc, params.solarLife);
    const batteryAnnual = batteryCapex * capitalRecoveryFactor(params.wacc, params.batteryLife);

    const solarOpex = solarCapex * params.solarOpexPct;
    const batteryOpex = batteryCapex * params.batteryOpexPct;

    const annualCost = solarAnnual + batteryAnnual + solarOpex + batteryOpex;
    const annualEnergyMWh = row.annual_cf * 8760 * BASE_LOAD_MW;
    if (annualEnergyMWh === 0) return Infinity;
    return annualCost / annualEnergyMWh;
}

function computeTransmissionMetrics(row, reference, delta) {
    if (!reference || !Number.isFinite(delta)) return null;
    const distanceKm = haversineKm(row.latitude, row.longitude, reference.latitude, reference.longitude);
    const savingsPerMwh = -delta; // positive if row cheaper
    if (!Number.isFinite(distanceKm)) {
        return null;
    }
    if (savingsPerMwh <= 0 || row.annual_cf <= 0) {
        return { distanceKm, savingsPerMwh, breakevenPerGw: 0, breakevenPerGwKm: 0 };
    }
    const annualEnergyMWh = row.annual_cf * 8760 * BASE_LOAD_MW;
    const annualPayment = savingsPerMwh * annualEnergyMWh;
    const breakevenPerGw = TX_CRF > 0 ? annualPayment / TX_CRF : 0;
    const breakevenPerGwKm = distanceKm > 0 ? breakevenPerGw / distanceKm : 0;
    return {
        distanceKm,
        savingsPerMwh,
        breakevenPerGw,
        breakevenPerGwKm
    };
}

function formatNumber(value, decimals = 0) {
    if (!Number.isFinite(value)) return '--';
    return value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

function formatCurrencyLabel(value, decimals = 0) {
    const num = formatNumber(value, decimals);
    return num === '--' ? '--' : `$${num}`;
}

function computeBestLcoeByLocation(targetCf, params) {
    const results = [];
    locationIndex.forEach(rows => {
        const payloads = [];
        let bestMeeting = null;
        let bestFallback = null;
        let maxSolar = -Infinity;
        let maxBatt = -Infinity;

        rows.forEach(r => {
            const lcoe = computeConfigLcoe(r, params);
            const payload = { ...r, lcoe, targetCf };
            payloads.push(payload);

            if (r.annual_cf >= targetCf) {
                if (!bestMeeting || lcoe < bestMeeting.lcoe) {
                    bestMeeting = payload;
                }
            }

            if (!bestFallback || r.annual_cf > bestFallback.annual_cf) {
                bestFallback = payload;
            }

            if (r.solar_gw > maxSolar || (r.solar_gw === maxSolar && r.batt_gwh > maxBatt)) {
                maxSolar = r.solar_gw;
                maxBatt = r.batt_gwh;
            }
        });

        const highConfig = payloads.find(p => p.solar_gw === maxSolar && p.batt_gwh === maxBatt) ||
            payloads.reduce((best, p) => {
                if (!best) return p;
                if (p.solar_gw > best.solar_gw) return p;
                if (p.solar_gw === best.solar_gw && p.batt_gwh > best.batt_gwh) return p;
                return best;
            }, null);

        const chosen = bestMeeting ? { ...bestMeeting, meetsTarget: true } :
            bestFallback ? { ...bestFallback, meetsTarget: false } : null;

        if (chosen) {
            chosen.maxConfigSolar = highConfig?.solar_gw ?? null;
            chosen.maxConfigBatt = highConfig?.batt_gwh ?? null;
            chosen.maxConfigLcoe = highConfig?.lcoe ?? null;
            results.push(chosen);
        }
    });
    return results;
}

function setLegendGradient(mode) {
    legendLcoeBar.classList.remove('legend-gradient-cost', 'legend-gradient-delta', 'legend-gradient-tx');
    if (mode === 'delta') {
        legendLcoeBar.classList.add('legend-gradient-delta');
    } else if (mode === 'tx') {
        legendLcoeBar.classList.add('legend-gradient-tx');
    } else {
        legendLcoeBar.classList.add('legend-gradient-cost');
    }
}

function setViewModeExplanation(mode) {
    if (!viewModeExplainer) return;
    const message = VIEW_MODE_EXPLANATIONS[mode] || VIEW_MODE_EXPLANATIONS.capacity;
    viewModeExplainer.textContent = message;
}

function updatePopulationOverlayControls(mode) {
    if (!populationOverlayConfig) return;

    // Show CF config controls (solar/batt sliders) when CF overlay selected
    const showCfControls = mode === 'cf';
    populationOverlayConfig.classList.toggle('hidden', !showCfControls);
    if (showCfControls) {
        if (populationSolarSlider) populationSolarSlider.value = currentSolar;
        if (populationSolarVal) populationSolarVal.textContent = currentSolar;
        if (populationBattSlider) populationBattSlider.value = currentBatt;
        if (populationBattVal) populationBattVal.textContent = currentBatt;
    }

    // Show LCOE controls when LCOE overlay selected in population mode
    const showLcoeControls = mode === 'lcoe';
    if (showLcoeControls && populationLcoeWrapper && lcoeControls) {
        // Store original location if not already stored
        if (!lcoeControlsOriginalParent && lcoeControls.parentElement) {
            lcoeControlsOriginalParent = lcoeControls.parentElement;
            lcoeControlsOriginalNextSibling = lcoeControls.nextSibling;
        }

        // Move LCOE controls to population wrapper
        populationLcoeWrapper.classList.remove('hidden');
        if (lcoeControls.parentElement !== populationLcoeWrapper) {
            populationLcoeWrapper.appendChild(lcoeControls);
        }
        lcoeControls.classList.remove('hidden');
    } else if (populationLcoeWrapper) {
        // Hide the wrapper when not in LCOE overlay mode
        populationLcoeWrapper.classList.add('hidden');
    }
}

function updatePopulationViewHelperCopy() {
    if (!populationViewHelper || !populationChartsCta) return;
    if (populationDisplayMode === 'charts') {
        populationViewHelper.textContent = 'Charts summarise whichever base layer is selected (population or installed capacity) by percentile and latitude.';
        populationChartsCta.textContent = 'Show map view';
    } else {
        populationViewHelper.textContent = 'Map mode shows the chosen base layer directly; Charts condense the same information by percentile and latitude band.';
        populationChartsCta.textContent = 'Show charts';
    }
}

function showMapContainerOnly() {
    const wasHidden = mapContainer?.classList.contains('hidden');
    if (mapContainer) mapContainer.classList.remove('hidden');
    if (populationChartsContainer) populationChartsContainer.classList.add('hidden');
    if (wasHidden) {
        // Give Leaflet a nudge to recalc sizes after being unhidden
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
}

function showPopulationChartsOnly() {
    if (mapContainer) mapContainer.classList.add('hidden');
    if (populationChartsContainer) populationChartsContainer.classList.remove('hidden');
}

function setLocationPanelChartSummary() {
    if (!locationPanel || !locValueEl || !locLabelEl) return;
    locationPanel.classList.remove('hidden');
    if (locCoordsEl) locCoordsEl.textContent = '--';
    locValueEl.textContent = 'All cells';
    locLabelEl.textContent = 'Charts summarize the entire population grid.';
    if (locConfigEl) locConfigEl.classList.add('hidden');
    if (locConfigTextEl) {
        locConfigTextEl.textContent = 'Switch back to Map view to explore individual cells.';
    }
    if (locTxInfoEl) locTxInfoEl.classList.add('hidden');
    locationPanelShowingChartSummary = true;
}

function resetLocationPanelAfterChartSummary() {
    if (!locationPanelShowingChartSummary) return;
    if (locCoordsEl) locCoordsEl.textContent = '--';
    if (locValueEl) locValueEl.textContent = '--';
    if (locLabelEl) locLabelEl.textContent = 'Select a location on the map to inspect it.';
    if (locConfigEl) locConfigEl.classList.add('hidden');
    locationPanelShowingChartSummary = false;
}

function updatePopulationDisplayToggleUI() {
    if (!populationDisplayButtons || populationDisplayButtons.length === 0) return;
    populationDisplayButtons.forEach(btn => {
        const isActive = btn.dataset.mode === populationDisplayMode;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

function updatePopulationOverlayToggleUI() {
    if (!populationOverlayButtons || populationOverlayButtons.length === 0) return;
    populationOverlayButtons.forEach(btn => {
        const isActive = btn.dataset.overlay === populationOverlayMode;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

function updatePopulationBaseToggleUI() {
    if (!populationBaseButtons || populationBaseButtons.length === 0) return;
    populationBaseButtons.forEach(btn => {
        const isActive = btn.dataset.base === populationBaseLayer;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
    if (populationFuelFilterWrapper) {
        populationFuelFilterWrapper.classList.toggle('hidden', populationBaseLayer !== 'plants');
    }
}

function updatePopulationFuelToggleUI() {
    if (!populationFuelButtons || populationFuelButtons.length === 0) return;
    populationFuelButtons.forEach(btn => {
        const fuel = btn.dataset.fuel;
        const isActive = populationFuelFilter.has(fuel);
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

function updateChartMetricToggleUI() {
    if (!populationChartMetricButtons || populationChartMetricButtons.length === 0) return;
    populationChartMetricButtons.forEach(btn => {
        const isActive = btn.dataset.metric === populationChartMetric;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

function updateChartLayerToggleUI() {
    if (!populationChartLayerButtons || populationChartLayerButtons.length === 0) return;
    populationChartLayerButtons.forEach(btn => {
        const isActive = btn.dataset.layer === populationBaseLayer;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

function updateChartOverlayToggleUI() {
    if (!populationChartOverlayButtons || populationChartOverlayButtons.length === 0) return;
    populationChartOverlayButtons.forEach(btn => {
        const isActive = btn.dataset.overlay === populationOverlayMode;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

function setPopulationChartMetric(mode) {
    const normalized = mode === 'lcoe' ? 'lcoe' : 'cf';
    populationChartMetric = normalized;
    updateChartMetricToggleUI();
    if (populationOverlayMode !== normalized) {
        populationOverlayMode = normalized;
        updatePopulationOverlayToggleUI();
        updatePopulationOverlayControls(normalized);
    }
    if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function setPopulationBaseLayer(mode) {
    const normalized = mode === 'plants' ? 'plants' : 'population';
    populationBaseLayer = normalized;
    updatePopulationBaseToggleUI();
    updateChartLayerToggleUI();
    updatePopulationFuelToggleUI();
    updatePopulationViewHelperCopy();
    if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function togglePopulationFuel(fuel) {
    if (!fuel) return;
    const normalized = fuel.toLowerCase();
    if (populationFuelFilter.has(normalized)) {
        if (populationFuelFilter.size === 1) return;
        populationFuelFilter.delete(normalized);
    } else {
        populationFuelFilter.add(normalized);
    }
    updatePopulationFuelToggleUI();
    if (populationBaseLayer === 'plants' && currentViewMode === 'population') {
        updatePopulationView();
    }
}

function setPopulationDisplayMode(mode) {
    const normalized = mode === 'charts' ? 'charts' : 'map';
    populationDisplayMode = normalized;
    updatePopulationDisplayToggleUI();
    updatePopulationViewHelperCopy();
    if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function moveLcoeControlsToOriginalPosition() {
    // Move LCOE controls back to their original position for LCOE view mode
    if (lcoeControls && lcoeControlsOriginalParent && lcoeControls.parentElement !== lcoeControlsOriginalParent) {
        if (lcoeControlsOriginalNextSibling) {
            lcoeControlsOriginalParent.insertBefore(lcoeControls, lcoeControlsOriginalNextSibling);
        } else {
            lcoeControlsOriginalParent.appendChild(lcoeControls);
        }
    }
}

function updatePopulationLegend(popData, overlayMode = 'none') {
    if (!legendPopulation || !legendPopMin || !legendPopMax) return;
    if (!popData || popData.length === 0) {
        legendPopulation.classList.add('hidden');
        return;
    }
    const vals = popData.map(p => p.population_2020 || 0).filter(Number.isFinite);
    const max = Math.max(...vals, 0);
    legendPopMin.textContent = '0';
    legendPopMax.textContent = max ? formatNumber(max, 0) : '--';
    legendPopulation.classList.remove('hidden');
    if (legendPopLayerNote) {
        if (overlayMode === 'cf') {
            legendPopLayerNote.textContent = 'Color: capacity factor map for the current solar + storage build.';
            legendPopLayerNote.classList.remove('text-slate-500');
            legendPopLayerNote.classList.add('text-slate-300');
        } else if (overlayMode === 'lcoe') {
            legendPopLayerNote.textContent = 'Color: LCOE for each viable cell.';
            legendPopLayerNote.classList.remove('text-slate-500');
            legendPopLayerNote.classList.add('text-slate-300');
        } else {
            legendPopLayerNote.textContent = 'Color: population shading only (no additional metric selected).';
            legendPopLayerNote.classList.remove('text-slate-300');
            legendPopLayerNote.classList.add('text-slate-500');
        }
    }
}

function setConfigNoteVisibility(show) {
    if (!configNote) return;
    configNote.classList.toggle('hidden', !show);
}

function updateComparisonToggleUI() {
    if (!comparisonButtons || comparisonButtons.length === 0) return;
    comparisonButtons.forEach(btn => {
        const isActive = btn.dataset.mode === comparisonMetric;
        btn.classList.toggle('bg-slate-800', isActive);
        btn.classList.toggle('text-slate-200', isActive);
        btn.classList.toggle('bg-slate-900', !isActive);
        btn.classList.toggle('text-slate-400', !isActive);
    });
}

function updateLegendLockButton() {
    if (!legendLockBtn) return;
    if (!lcoeReference) {
        legendLockBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        legendLockBtn.textContent = 'Fix legend scales';
    } else {
        legendLockBtn.classList.remove('hidden');
        legendLockBtn.textContent = legendLock ? 'Release legend scales' : 'Fix legend scales';
    }
}

function renderLegendFromInfo(info) {
    if (!info) {
        legendLcoeMin.textContent = '--';
        legendLcoeMid.textContent = '--';
        legendLcoeMax.textContent = '--';
        legendLcoeRef.textContent = 'Reference: --';
        if (legendLcoeNoData) {
            legendLcoeNoData.textContent = '';
            legendLcoeNoData.classList.add('hidden');
        }
        if (legendLcoeTitle) legendLcoeTitle.textContent = 'LCOE ($/MWh)';
        setLegendGradient('cost');
        legendTxExplainer?.classList.add('hidden');
        comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        updateLegendLockButton();
        return;
    }

    if (legendLcoeTitle) {
        legendLcoeTitle.textContent = info.title || 'LCOE ($/MWh)';
    }
    legendLcoeMin.textContent = info.minLabel || '--';
    legendLcoeMid.textContent = info.midLabel || '--';
    legendLcoeMax.textContent = info.maxLabel || '--';
    legendLcoeRef.textContent = info.refLabel || 'Reference: --';
    if (legendLcoeNoData) {
        legendLcoeNoData.innerHTML = '';
        if (info.noDataLabel) {
            const swatch = document.createElement('span');
            swatch.style.backgroundColor = LCOE_NO_DATA_COLOR;
            swatch.style.display = 'inline-block';
            swatch.style.width = '12px';
            swatch.style.height = '12px';
            swatch.style.borderRadius = '3px';
            const label = document.createElement('span');
            label.textContent = ` ${info.noDataLabel} (no data / target not met)`;
            legendLcoeNoData.appendChild(swatch);
            legendLcoeNoData.appendChild(label);
            legendLcoeNoData.classList.remove('hidden');
        } else {
            legendLcoeNoData.classList.add('hidden');
        }
    }
    setLegendGradient(info.gradient || 'cost');
    if (legendTxExplainer) {
        if (info.type === 'tx') {
            legendTxExplainer.classList.remove('hidden');
        } else {
            legendTxExplainer.classList.add('hidden');
        }
    }

    if (info.showComparison) {
        comparisonToggle.classList.remove('hidden');
        clearRefBtn.classList.remove('hidden');
        updateComparisonToggleUI();
        updateLegendLockButton();
    } else {
        comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    }
}

function updateLcoeLegend(points, overrideInfo = null) {
    if (overrideInfo) {
        renderLegendFromInfo(overrideInfo);
        return overrideInfo;
    }

    const valid = points.filter(p => p.meetsTarget && Number.isFinite(p.lcoe));
    if (!valid.length) {
        const info = {
            type: 'lcoe',
            title: 'LCOE ($/MWh)',
            minLabel: '--',
            midLabel: '--',
            maxLabel: '--',
            refLabel: 'Reference: --',
            gradient: 'cost',
            showComparison: false,
            domain: null
        };
        renderLegendFromInfo(info);
        return info;
    }

    if (lcoeReference) {
        if (comparisonMetric === 'tx') {
            const txValues = points
                .filter(p => p.meetsTarget && p.txMetrics && p.txMetrics.breakevenPerGwKm > 0)
                .map(p => p.txMetrics.breakevenPerGwKm)
                .sort((a, b) => a - b);
            let domain;
            let minLabel = '$0/GW/km';
            let midLabel = '--';
            let maxLabel = '--';
            if (txValues.length) {
                const pick = (q) => txValues[Math.min(txValues.length - 1, Math.max(0, Math.floor(q * txValues.length)))];
                const rawMax = pick(0.95) || txValues[txValues.length - 1];
                const max = Math.max(rawMax, 1);
                const mid = Math.max(pick(0.5), max * 0.5);
                domain = [0, mid, max];
                midLabel = `${formatCurrencyLabel(mid)}/GW/km`;
                maxLabel = `${formatCurrencyLabel(max)}/GW/km`;
            } else {
                domain = [0, 1, 1];
            }
            const info = {
                type: 'tx',
                domain,
                title: 'Breakeven Transmission ($/GW/km)',
                minLabel,
                midLabel,
                maxLabel,
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'tx',
                showComparison: true,
                noDataLabel: `> ${maxLabel}`
            };
            renderLegendFromInfo(info);
            return info;
        }

        const withDelta = points.filter(p => p.meetsTarget && Number.isFinite(p.delta));
        let info;
        if (!withDelta.length) {
            info = {
                type: 'delta',
                maxAbs: 1,
                title: 'LCOE Δ ($/MWh)',
                minLabel: '--',
                midLabel: '$0',
                maxLabel: '--',
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'delta',
                showComparison: true,
                noDataLabel: ''
            };
        } else {
            const absVals = withDelta.map(p => Math.abs(p.delta)).sort((a, b) => a - b);
            const pick = (q) => absVals[Math.min(absVals.length - 1, Math.max(0, Math.floor(q * absVals.length)))];
            const maxAbs = Math.max(1, pick(DELTA_PERCENTILE) || absVals[absVals.length - 1] || 1);
            const labelVal = Math.max(1, Math.round(maxAbs));
            info = {
                type: 'delta',
                maxAbs: labelVal,
                title: 'LCOE Δ ($/MWh)',
                minLabel: `-${formatCurrencyLabel(labelVal)}`,
                midLabel: '$0',
                maxLabel: `+${formatCurrencyLabel(labelVal)}`,
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'delta',
                showComparison: true,
                noDataLabel: `Outside target CF`
            };
        }
        renderLegendFromInfo(info);
        return info;
    }

    const costs = valid.map(p => p.lcoe).sort((a, b) => a - b);
    const pick = (q) => costs[Math.floor(q * (costs.length - 1))];
    const min = costs[0];
    const median = pick(0.5);
    const max = costs[costs.length - 1];

    const domain = [min, pick(0.33), pick(0.67), max];
    const info = {
        type: 'lcoe',
        domain,
        title: 'LCOE ($/MWh)',
        minLabel: formatCurrencyLabel(min),
        midLabel: formatCurrencyLabel(median),
        maxLabel: formatCurrencyLabel(max),
        refLabel: 'Reference: --',
        gradient: 'cost',
        showComparison: false,
        noDataLabel: max ? `> ${formatCurrencyLabel(max)}` : ''
    };
    renderLegendFromInfo(info);
    return info;
}

function queueLcoeUpdate() {
    // Check if we need to update LCOE view
    const isLcoeMode = currentViewMode === 'lcoe';
    const isPopulationWithLcoeOverlay = currentViewMode === 'population' && populationOverlayMode === 'lcoe';

    if (!isLcoeMode && !isPopulationWithLcoeOverlay) return;

    if (lcoeUpdateTimeout) {
        clearTimeout(lcoeUpdateTimeout);
    }
    lcoeUpdateTimeout = setTimeout(() => {
        lcoeUpdateTimeout = null;
        if (currentViewMode === 'lcoe') {
            updateLcoeView();
        } else if (currentViewMode === 'population') {
            updatePopulationView();
        }
    }, 150);
}

function buildPopulationMetrics(enrichedPop, overlayMode, cfData, lcoeData) {
    const cfByCoord = new Map(cfData.map(d => [coordKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [coordKey(d.latitude, d.longitude), d]));
    return enrichedPop.map(p => {
        const key = coordKey(p.latitude, p.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);
        const weight = Math.max(0, p.population_2020 || 0);
        let metricVal;
        if (overlayMode === 'cf') {
            metricVal = cfRow?.annual_cf;
        } else if (overlayMode === 'lcoe') {
            metricVal = lcoeRow?.lcoe;
        } else {
            metricVal = weight;
        }
        if ((overlayMode === 'cf' || overlayMode === 'lcoe') && !Number.isFinite(metricVal)) {
            return null;
        }
        return {
            latitude: p.latitude,
            longitude: p.longitude,
            metric: metricVal,
            weight
        };
    }).filter(m => (overlayMode === 'cf' || overlayMode === 'lcoe') ? Number.isFinite(m.metric) : m.weight > 0);
}

function buildPlantMetrics(capacityRows, overlayMode, cfData, lcoeData, selectedFuels) {
    const cfById = new Map(cfData.map(d => [d.location_id, d]));
    const lcoeById = new Map(lcoeData.map(d => [d.location_id, d]));
    const fuelSet = selectedFuels && selectedFuels.size ? selectedFuels : new Set(ALL_FUELS);
    return capacityRows.map(row => {
        let totalMw = 0;
        fuelSet.forEach(fuel => {
            const col = `${fuel}_mw`;
            totalMw += Math.max(0, Number(row[col]) || 0);
        });
        if (!totalMw) return null;
        let metricVal;
        if (overlayMode === 'cf') {
            metricVal = cfById.get(row.location_id)?.annual_cf;
        } else if (overlayMode === 'lcoe') {
            metricVal = lcoeById.get(row.location_id)?.lcoe;
        } else {
            metricVal = totalMw;
        }
        if ((overlayMode === 'cf' || overlayMode === 'lcoe') && !Number.isFinite(metricVal)) {
            return null;
        }
        return {
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
            metric: metricVal,
            weight: totalMw
        };
    }).filter(Boolean);
}

function buildWeightedHistogram(metrics, overlayMode, bucketCount = 50) {
    // Build histogram with CF or LCOE on x-axis and population/capacity on y-axis
    if (!metrics.length) return { labels: [], data: [] };

    // For overlays (CF or LCOE), bucket by the metric value
    if (overlayMode === 'cf' || overlayMode === 'lcoe') {
        // Filter metrics with valid metric values
        const validMetrics = metrics.filter(m => Number.isFinite(m.metric));
        if (!validMetrics.length) return { labels: [], data: [] };

        // Determine min and max for the metric
        const metricValues = validMetrics.map(m => m.metric);
        const minMetric = Math.min(...metricValues);
        const maxMetric = Math.max(...metricValues);

        // Create buckets
        const bucketSize = (maxMetric - minMetric) / bucketCount;
        if (bucketSize === 0) {
            // All values are the same
            return {
                labels: [overlayMode === 'cf' ? `${(minMetric * 100).toFixed(1)}%` : `$${minMetric.toFixed(0)}`],
                data: [validMetrics.reduce((sum, m) => sum + (m.weight || 0), 0)]
            };
        }

        const buckets = Array.from({ length: bucketCount }, (_, i) => ({
            min: minMetric + i * bucketSize,
            max: minMetric + (i + 1) * bucketSize,
            weight: 0
        }));

        // Distribute metrics into buckets
        validMetrics.forEach(m => {
            const bucketIdx = Math.min(bucketCount - 1, Math.floor((m.metric - minMetric) / bucketSize));
            buckets[bucketIdx].weight += m.weight || 0;
        });

        // Create labels and data
        const labels = buckets.map(b => {
            const midpoint = (b.min + b.max) / 2;
            if (overlayMode === 'cf') {
                return `${(midpoint * 100).toFixed(1)}%`;
            } else {
                return `$${midpoint.toFixed(0)}`;
            }
        });
        const data = buckets.map(b => b.weight);

        return { labels, data };
    } else {
        // For no overlay, show percentile-based distribution
        // Sort by metric descending and calculate cumulative weight percentiles
        const sorted = [...metrics].filter(m => Number.isFinite(m.metric) && m.weight > 0).sort((a, b) => b.metric - a.metric);
        if (!sorted.length) return { labels: [], data: [] };

        const totalWeight = sorted.reduce((sum, m) => sum + m.weight, 0);
        const percentileCount = 100;
        const labels = [];
        const data = [];

        for (let i = 0; i < percentileCount; i++) {
            labels.push(`${i}%`);
            const targetPercentile = i / 100;
            let cumWeight = 0;
            let metricAtPercentile = sorted[0].metric;

            for (const m of sorted) {
                cumWeight += m.weight;
                if (cumWeight / totalWeight >= targetPercentile) {
                    metricAtPercentile = m.metric;
                    break;
                }
            }
            data.push(metricAtPercentile);
        }

        return { labels, data };
    }
}

function buildWeightedLatitudeHistogram(metrics, bucketCount = 100) {
    const totalWeight = metrics.reduce((sum, m) => sum + (m.weight || 0), 0);
    if (!totalWeight) return { labels: [], data: [] };

    const bucketSize = 180 / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        min: -90 + i * bucketSize,
        max: -90 + (i + 1) * bucketSize,
        weight: 0
    }));

    metrics.forEach(m => {
        if (!Number.isFinite(m.latitude)) return;
        const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((m.latitude + 90) / bucketSize)));
        buckets[idx].weight += m.weight || 0;
    });

    const labels = buckets.map(b => `${((b.min + b.max) / 2).toFixed(1)}°`);
    const data = buckets.map(b => (b.weight / totalWeight) * 100);
    return {
        labels: labels.reverse(),
        data: data.reverse()
    };
}

function destroyChart(chart) {
    if (chart) {
        chart.destroy();
    }
}

function renderPopulationCharts(metrics, { overlayMode, baseLayer, selectedFuels }) {
    if (!populationChartHistogram || !populationChartLatMetric || !populationChartLatPop) return;
    const ChartJS = window.Chart;
    if (!ChartJS) return;
    const isCf = overlayMode === 'cf';
    const isLcoe = overlayMode === 'lcoe';
    const fuelSet = selectedFuels instanceof Set ? selectedFuels : (selectedFuels ? new Set(selectedFuels) : new Set(ALL_FUELS));
    const fuelDescriptor = describeFuelSelection(fuelSet);
    const weightDescriptor = baseLayer === 'plants' ? `${fuelDescriptor} capacity` : 'population';
    let metricLabel;
    if (isCf) {
        metricLabel = 'Capacity Factor (%)';
    } else if (isLcoe) {
        metricLabel = 'LCOE ($/MWh)';
    } else if (baseLayer === 'plants') {
        const prefix = fuelDescriptor === 'fossil' ? 'Fossil' : capitalizeWord(fuelDescriptor);
        metricLabel = `${prefix} capacity (MW)`;
    } else {
        metricLabel = 'Population (people)';
    }
    const normalizeMetric = (val) => {
        if (!Number.isFinite(val)) return val;
        if (isCf) return val * 100;
        return val;
    };

    const histogram = buildWeightedHistogram(metrics, overlayMode);

    // Determine axis labels, titles, and helpers based on overlay mode
    let xAxisLabel, yAxisLabel, histogramMainTitle, histogramHelperText, scatterXAxisLabel, histogramTooltip;
    if (overlayMode === 'cf') {
        xAxisLabel = 'Capacity Factor (%)';
        yAxisLabel = weightDescriptor === 'population' ? 'Population (people)' : `${capitalizeWord(fuelDescriptor)} capacity (MW)`;
        scatterXAxisLabel = 'Capacity Factor (%)';
        histogramMainTitle = 'Distribution by Capacity Factor';
        histogramHelperText = weightDescriptor === 'population'
            ? 'Shows total population as a function of Capacity Factor'
            : `Shows total ${fuelDescriptor} capacity as a function of Capacity Factor`;
        histogramTooltip = (ctx) => {
            const weight = ctx?.parsed?.y;
            const bucket = ctx?.label;
            if (!Number.isFinite(weight)) return '--';

            if (weightDescriptor === 'population') {
                const millions = weight / 1e6;
                if (millions >= 1) {
                    return `${bucket}: ${millions.toFixed(2)}M people`;
                } else {
                    return `${bucket}: ${weight.toLocaleString()} people`;
                }
            } else {
                return `${bucket}: ${weight.toFixed(0)} MW`;
            }
        };
    } else if (overlayMode === 'lcoe') {
        xAxisLabel = 'LCOE ($/MWh)';
        yAxisLabel = weightDescriptor === 'population' ? 'Population (people)' : `${capitalizeWord(fuelDescriptor)} capacity (MW)`;
        scatterXAxisLabel = 'LCOE ($/MWh)';
        histogramMainTitle = 'Distribution by LCOE';
        histogramHelperText = weightDescriptor === 'population'
            ? 'Shows total population as a function of LCOE'
            : `Shows total ${fuelDescriptor} capacity as a function of LCOE`;
        histogramTooltip = (ctx) => {
            const weight = ctx?.parsed?.y;
            const bucket = ctx?.label;
            if (!Number.isFinite(weight)) return '--';

            if (weightDescriptor === 'population') {
                const millions = weight / 1e6;
                if (millions >= 1) {
                    return `${bucket}: ${millions.toFixed(2)}M people`;
                } else {
                    return `${bucket}: ${weight.toLocaleString()} people`;
                }
            } else {
                return `${bucket}: ${weight.toFixed(0)} MW`;
            }
        };
    } else {
        // When no overlay, show population or capacity by percentiles
        xAxisLabel = `Cumulative global ${weightDescriptor} (%)`;
        yAxisLabel = metricLabel;
        scatterXAxisLabel = metricLabel;
        histogramMainTitle = `${metricLabel} by percentile`;
        histogramHelperText = `Shows ${metricLabel.toLowerCase()} across ${weightDescriptor} percentiles`;
        histogramTooltip = (ctx) => {
            const value = ctx?.parsed?.y;
            if (!Number.isFinite(value)) return `${metricLabel}: --`;
            const decimals = isCf ? 1 : 0;
            return `${metricLabel}: ${value.toFixed(decimals)}`;
        };
    }

    // Update top histogram chart title and helper text
    if (populationChartHistogramTitle) {
        populationChartHistogramTitle.textContent = histogramMainTitle;
    }
    if (populationChartHistogramLabel) {
        populationChartHistogramLabel.textContent = histogramHelperText;
    }

    // Update bottom-left chart title and label
    let latMetricTitle;
    if (overlayMode === 'cf') {
        latMetricTitle = 'Capacity Factor by latitude';
    } else if (overlayMode === 'lcoe') {
        latMetricTitle = 'LCOE by latitude';
    } else {
        latMetricTitle = `${metricLabel} by latitude`;
    }

    if (populationChartLatMetricTitle) {
        populationChartLatMetricTitle.textContent = latMetricTitle;
    }
    if (populationChartMetricLabel) {
        populationChartMetricLabel.textContent = `${scatterXAxisLabel} by latitude (weighted by ${weightDescriptor})`;
    }

    // Update bottom-right chart labels
    const latPopTitle = weightDescriptor === 'population' ? 'Population share by latitude' : `${capitalizeWord(fuelDescriptor)} capacity share by latitude`;
    const latPopHelper = weightDescriptor === 'population'
        ? 'Each bar = % of global population in that latitude band'
        : `Each bar = % of global ${fuelDescriptor} capacity in that latitude band`;

    if (populationChartLatPopLabel) {
        populationChartLatPopLabel.textContent = latPopTitle;
    }
    if (populationChartLatPopHelper) {
        populationChartLatPopHelper.textContent = latPopHelper;
    }

    const chartsNeedRecreate = populationCharts.metric !== metricLabel;
    if (chartsNeedRecreate) {
        destroyChart(populationCharts.histogram);
        destroyChart(populationCharts.latMetric);
        destroyChart(populationCharts.latPop);
        populationCharts.histogram = null;
        populationCharts.latMetric = null;
        populationCharts.latPop = null;
        populationCharts.metric = metricLabel;
    }

    if (!populationCharts.histogram) {
        populationCharts.histogram = new ChartJS(populationChartHistogram.getContext('2d'), {
            type: 'bar',
            data: {
                labels: histogram.labels,
                datasets: [{
                    label: yAxisLabel,
                    data: histogram.data,
                    backgroundColor: 'rgba(56, 189, 248, 0.45)',
                    borderColor: 'rgba(56, 189, 248, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: histogramTooltip
                        }
                    }
                },
                scales: {
                    x: { title: { display: true, text: xAxisLabel } },
                    y: { title: { display: true, text: yAxisLabel } }
                }
            }
        });
    } else {
        populationCharts.histogram.data.labels = histogram.labels;
        populationCharts.histogram.data.datasets[0].label = yAxisLabel;
        populationCharts.histogram.data.datasets[0].data = histogram.data;
        populationCharts.histogram.options.scales.x.title.text = xAxisLabel;
        populationCharts.histogram.options.scales.y.title.text = yAxisLabel;
        populationCharts.histogram.options.plugins.tooltip.callbacks.label = histogramTooltip;
        populationCharts.histogram.update();
    }

    const metricScatterData = metrics.map(m => ({ x: normalizeMetric(m.metric), y: m.latitude }));

    if (!populationCharts.latMetric) {
        populationCharts.latMetric = new ChartJS(populationChartLatMetric.getContext('2d'), {
            type: 'scatter',
            data: {
                datasets: [{
                    label: scatterXAxisLabel,
                    data: metricScatterData,
                    backgroundColor: 'rgba(52, 211, 153, 0.6)',
                    borderColor: 'rgba(52, 211, 153, 1)',
                    pointRadius: 3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { title: { display: true, text: scatterXAxisLabel } },
                    y: { title: { display: true, text: 'Latitude' }, min: -90, max: 90 }
                }
            }
        });
    } else {
        populationCharts.latMetric.data.datasets[0].label = scatterXAxisLabel;
        populationCharts.latMetric.data.datasets[0].data = metricScatterData;
        populationCharts.latMetric.options.scales.x.title.text = scatterXAxisLabel;
        populationCharts.latMetric.update();
    }

    const popHistogram = buildWeightedLatitudeHistogram(metrics);
    const descriptorLabel = weightDescriptor === 'population' ? 'Population' : `${capitalizeWord(fuelDescriptor)} capacity`;

    if (!populationCharts.latPop) {
        populationCharts.latPop = new ChartJS(populationChartLatPop.getContext('2d'), {
            type: 'bar',
            data: {
                labels: popHistogram.labels,
                datasets: [{
                    label: `${descriptorLabel} share (%)`,
                    data: popHistogram.data,
                    backgroundColor: 'rgba(248, 180, 0, 0.65)',
                    borderColor: 'rgba(251, 191, 36, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const val = ctx?.parsed?.x;
                                return Number.isFinite(val) ? `${val.toFixed(2)}% of global ${weightDescriptor}` : '--';
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        title: { display: true, text: `Share of global ${weightDescriptor} (%)` }
                    },
                    y: {
                        title: { display: true, text: 'Latitude band (°)' },
                        ticks: { autoSkip: true, maxTicksLimit: 10 }
                    }
                }
            }
        });
    } else {
        populationCharts.latPop.data.labels = popHistogram.labels;
        populationCharts.latPop.data.datasets[0].label = `${descriptorLabel} share (%)`;
        populationCharts.latPop.data.datasets[0].data = popHistogram.data;
        populationCharts.latPop.options.scales.x.title.text = `Share of global ${weightDescriptor} (%)`;
        populationCharts.latPop.options.plugins.tooltip.callbacks.label = (ctx) => {
            const val = ctx?.parsed?.x;
            return Number.isFinite(val) ? `${val.toFixed(2)}% of global ${weightDescriptor}` : '--';
        };
        populationCharts.latPop.update();
    }
}

async function init() {
    try {
        // Initialize Map
        await initMap(handleLocationSelect);

        // Initialize Hourly Profile Samples
        initSampleDays();

        // Load Data
        loadingStatus.textContent = "Downloading summary data...";
        summaryData = await loadSummary();
        locationIndex = buildLocationIndex(summaryData);
        summaryCoordIndex = buildCoordIndex(summaryData);
        try {
            populationData = await loadPopulationCsv();
            populationCoordIndex = buildCoordIndex(populationData);
        } catch (err) {
            console.error("Population data load failed:", err);
            populationData = [];
            populationCoordIndex = new Map();
        }
        try {
            voronoiGeojson = await loadVoronoiGeojson();
        } catch (err) {
            console.error("Voronoi geojson load failed:", err);
            voronoiGeojson = null;
        }
        try {
            fossilPlants = await loadFossilPlantsCsv();
        } catch (err) {
            console.error("Fossil plant CSV load failed:", err);
            fossilPlants = [];
        }
        try {
            fossilCapacity = await loadVoronoiFossilCapacityCsv();
            fossilCapacityMap = new Map(fossilCapacity.map(row => [row.location_id, row]));
        } catch (err) {
            console.error("Fossil capacity CSV load failed:", err);
            fossilCapacity = [];
            fossilCapacityMap = new Map();
        }

        loadingStatus.textContent = "Processing...";
        console.log("Loaded summary data. Rows:", summaryData.length);
        updateUI();

        // Hide Loading
        loading.classList.add('hidden');

    } catch (err) {
        console.error(err);
        loadingStatus.textContent = "Error loading data: " + err.message;
        loadingStatus.classList.add('text-red-500');
    }
}

function updateUI() {
    if (currentViewMode === 'capacity') {
        // Update Map with CF data
        updateMap(summaryData, currentSolar, currentBatt);
        legendPopulation?.classList.add('hidden');
        legendFossilPlants?.classList.add('hidden');
    } else if (currentViewMode === 'lcoe') {
        updateLcoeView();
        legendPopulation?.classList.add('hidden');
        legendFossilPlants?.classList.add('hidden');
    } else if (currentViewMode === 'population') {
        updatePopulationView();
        legendPopulation?.classList.remove('hidden');
    } else {
        // Sample mode
        legendPopulation?.classList.add('hidden');
        legendFossilPlants?.classList.add('hidden');
    }
}

function prepareLcoeDisplayData() {
    if (!summaryData.length || locationIndex.size === 0) return;
    lcoeResults = computeBestLcoeByLocation(lcoeParams.targetCf, lcoeParams);

    // Sync reference to freshest data
    let ref = null;
    if (lcoeReference) {
        ref = lcoeResults.find(r => r.location_id === lcoeReference.location_id) || null;
        lcoeReference = ref;
    }

    const wantsComparison = Boolean(ref);
    const desiredType = wantsComparison ? (comparisonMetric === 'tx' ? 'tx' : 'delta') : 'lcoe';
    if (!wantsComparison) {
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    } else if (legendLock && lockedColorInfo && lockedColorInfo.type !== desiredType) {
        lockedColorInfo = null;
    }

    const resultsWithDelta = lcoeResults.map(r => {
        const delta = ref ? r.lcoe - ref.lcoe : null;
        const txMetrics = ref ? computeTransmissionMetrics(r, ref, delta) : null;
        return { ...r, delta, txMetrics };
    });

    let colorInfo;
    if (legendLock && lockedColorInfo) {
        colorInfo = updateLcoeLegend(resultsWithDelta, lockedColorInfo);
    } else {
        colorInfo = updateLcoeLegend(resultsWithDelta);
        if (legendLock) {
            lockedColorInfo = colorInfo;
        }
    }
    lastColorInfo = colorInfo;

    return { resultsWithDelta, ref, colorInfo };
}

function updateLcoeView() {
    const prepared = prepareLcoeDisplayData();
    if (!prepared) return;
    const { resultsWithDelta, ref, colorInfo } = prepared;

    updateLcoeMap(resultsWithDelta, {
        targetCf: lcoeParams.targetCf,
        colorInfo,
        reference: ref,
        comparisonMetric
    });
}

function refreshActiveLcoeView() {
    if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
        updatePopulationView();
    } else {
        updateLcoeView();
    }
}

async function handleLocationSelect(locationData) {
    currentLocationId = locationData?.location_id ?? null;
    const isPopulationLcoe = currentViewMode === 'population' && populationOverlayMode === 'lcoe';
    if ((currentViewMode === 'lcoe' || isPopulationLcoe) && locationData) {
        lcoeReference = locationData;
        refreshActiveLcoeView();
    }
}

function switchViewMode(mode) {
    setViewModeExplanation(mode);
    currentViewMode = mode;

    // Sync chart view mode dropdown with main selector
    if (viewModeChartSelect && viewModeChartSelect.value !== mode) {
        viewModeChartSelect.value = mode;
    }

    cleanupSampleDays();
    if (mode !== 'population' && locationPanelShowingChartSummary) {
        resetLocationPanelAfterChartSummary();
    }

    if (mode === 'capacity') {
        // Show capacity elements
        statsSection.classList.remove('hidden');
        statsMetrics?.classList.remove('hidden');
        locationPanel?.classList.remove('hidden');
        showMapContainerOnly();
        legendPopulation?.classList.add('hidden');
        systemConfig?.classList.remove('hidden');
        setConfigNoteVisibility(true);
        populationToggleWrapper?.classList.add('hidden');
        sampleControls.classList.add('hidden');
        lcoeControls.classList.add('hidden');
        legendCapacity.classList.remove('hidden');
        legendSamples.classList.add('hidden');
        legendLcoe.classList.add('hidden');
        if (comparisonToggle) comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();

        // Update map with CF data
        updateMap(summaryData, currentSolar, currentBatt);
    } else if (mode === 'samples') {
        // Show sample elements
        statsSection.classList.add('hidden');
        locationPanel?.classList.add('hidden');
        showMapContainerOnly();
        legendPopulation?.classList.add('hidden');
        systemConfig?.classList.remove('hidden');
        setConfigNoteVisibility(true);
        populationToggleWrapper?.classList.add('hidden');
        sampleControls.classList.remove('hidden');
        lcoeControls.classList.add('hidden');
        legendCapacity.classList.add('hidden');
        legendSamples.classList.remove('hidden');
        legendLcoe.classList.add('hidden');
        populationToggleWrapper?.classList.add('hidden');
        if (comparisonToggle) comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();

        // Load sample week data
        loadSampleWeekData(currentSolar, currentBatt, summaryData);
    } else if (mode === 'lcoe') {
        statsSection.classList.add('hidden');
        locationPanel?.classList.remove('hidden');
        sampleControls.classList.add('hidden');
        moveLcoeControlsToOriginalPosition(); // Move LCOE controls back to original position
        lcoeControls.classList.remove('hidden');
        showMapContainerOnly();
        legendPopulation?.classList.add('hidden');
        systemConfig?.classList.add('hidden');
        setConfigNoteVisibility(false);
        legendCapacity.classList.add('hidden');
        legendSamples.classList.add('hidden');
        legendLcoe.classList.remove('hidden');
        populationToggleWrapper?.classList.add('hidden');

        updateLcoeView();
    } else if (mode === 'population') {
        statsSection.classList.remove('hidden');
        statsMetrics?.classList.add('hidden');
        locationPanel?.classList.remove('hidden');
        sampleControls.classList.add('hidden');
        lcoeControls.classList.add('hidden');
        systemConfig?.classList.add('hidden');
        setConfigNoteVisibility(false);
        legendCapacity.classList.add('hidden');
        legendSamples.classList.add('hidden');
        legendLcoe.classList.add('hidden');
        populationToggleWrapper?.classList.remove('hidden');
        updatePopulationView();
    }
}

setViewModeExplanation(currentViewMode);
setConfigNoteVisibility(currentViewMode !== 'lcoe');
if (currentViewMode === 'population') {
    populationToggleWrapper?.classList.remove('hidden');
}
legendPopulation?.classList.add('hidden');
if (populationSolarSlider) {
    populationSolarSlider.value = currentSolar;
    if (populationSolarVal) populationSolarVal.textContent = currentSolar;
}
if (populationBattSlider) {
    populationBattSlider.value = currentBatt;
    if (populationBattVal) populationBattVal.textContent = currentBatt;
}
updatePopulationDisplayToggleUI();
updatePopulationOverlayToggleUI();
updatePopulationBaseToggleUI();
updatePopulationFuelToggleUI();
updateChartMetricToggleUI();
updatePopulationViewHelperCopy();

// Event Listeners
function handleSolarInput(value, origin = 'main') {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(1, Math.min(20, parsed));
    currentSolar = clamped;
    if (solarVal) solarVal.textContent = clamped;
    if (populationSolarVal) populationSolarVal.textContent = clamped;
    if (solarSlider && origin !== 'main') solarSlider.value = clamped;
    if (populationSolarSlider && origin !== 'population') populationSolarSlider.value = clamped;
    if (currentSolar >= 11 && currentBatt < 18) {
        handleBattInput(18, 'auto');
    }
    if (currentViewMode === 'capacity') {
        updateUI();
    } else if (currentViewMode === 'samples') {
        loadSampleWeekData(currentSolar, currentBatt, summaryData);
    } else if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function handleBattInput(value, origin = 'main') {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    let clamped = Math.max(0, Math.min(36, parsed));
    if (currentSolar >= 11) {
        clamped = Math.max(18, clamped);
    }
    currentBatt = clamped;
    if (battVal) battVal.textContent = clamped;
    if (populationBattVal) populationBattVal.textContent = clamped;
    if (battSlider) battSlider.value = clamped;
    if (populationBattSlider) populationBattSlider.value = clamped;
    if (currentViewMode === 'capacity') {
        updateUI();
    } else if (currentViewMode === 'samples') {
        loadSampleWeekData(currentSolar, currentBatt, summaryData);
    } else if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

solarSlider.addEventListener('input', (e) => handleSolarInput(e.target.value, 'main'));

battSlider.addEventListener('input', (e) => handleBattInput(e.target.value, 'main'));

populationSolarSlider?.addEventListener('input', (e) => handleSolarInput(e.target.value, 'population'));

populationBattSlider?.addEventListener('input', (e) => handleBattInput(e.target.value, 'population'));

viewModeSelect.addEventListener('change', (e) => {
    switchViewMode(e.target.value);
});

targetCfSlider.addEventListener('input', (e) => {
    const pct = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
    lcoeParams.targetCf = pct / 100;
    targetCfVal.textContent = pct;
    queueLcoeUpdate();
});

function updatePopulationView() {
    if (!populationData.length) return;
    const isChartMode = populationDisplayMode === 'charts';
    const baseLayer = populationBaseLayer;
    const overlayMode = populationOverlayMode;
    const selectedFuelsArr = Array.from(populationFuelFilter);
    const selectedFuelSet = selectedFuelsArr.length ? new Set(selectedFuelsArr) : new Set(ALL_FUELS);
    updatePopulationOverlayControls(overlayMode);

    // Combine population with coordinates from summary
    const enriched = populationData.map(p => {
        const coords = summaryCoordIndex.get(coordKey(p.latitude, p.longitude)) || populationCoordIndex.get(coordKey(p.latitude, p.longitude)) || {};
        const lat = Number.isFinite(coords.latitude) ? coords.latitude : p.latitude;
        const lon = Number.isFinite(coords.longitude) ? coords.longitude : p.longitude;
        const locId = Number.isFinite(coords.location_id) ? Number(coords.location_id) : (Number.isFinite(p.location_id) ? Number(p.location_id) : null);
        return {
            ...p,
            latitude: lat,
            longitude: lon,
            annual_cf: coords.annual_cf,
            location_id: locId
        };
    }).filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));

    // Use current solar/batt selection to fetch CF overlay
    const cfFiltered = summaryData.filter(d => d.solar_gw === currentSolar && d.batt_gwh === currentBatt);
    let lcoeDisplay = null;
    if (overlayMode === 'lcoe') {
        // Reuse the exact LCOE selection + legend logic from the LCOE view
        lcoeDisplay = prepareLcoeDisplayData();
        legendLcoe.classList.remove('hidden');
        legendCapacity.classList.add('hidden');
    } else if (overlayMode === 'cf') {
        legendCapacity.classList.remove('hidden');
        legendLcoe.classList.add('hidden');
    } else {
        legendCapacity.classList.add('hidden');
        legendLcoe.classList.add('hidden');
    }
    if (baseLayer === 'population') {
        updatePopulationLegend(enriched, overlayMode);
    } else {
        legendPopulation?.classList.add('hidden');
    }
    if (isChartMode) {
        legendFossilPlants?.classList.add('hidden');
        setLocationPanelChartSummary();
        legendPopulation?.classList.add('hidden');
        legendCapacity?.classList.add('hidden');
        legendLcoe?.classList.add('hidden');
        showPopulationChartsOnly();
        const lcoeSource = overlayMode === 'lcoe' && lcoeDisplay ? lcoeDisplay.resultsWithDelta : lcoeResults;
        const metrics = baseLayer === 'plants'
            ? buildPlantMetrics(fossilCapacity, overlayMode, cfFiltered, lcoeSource, selectedFuelSet)
            : buildPopulationMetrics(enriched, overlayMode, cfFiltered, lcoeSource);
        renderPopulationCharts(metrics, { overlayMode, baseLayer, selectedFuels: selectedFuelSet });
    } else {
        resetLocationPanelAfterChartSummary();
        if (baseLayer === 'population') {
            legendPopulation?.classList.remove('hidden');
            legendFossilPlants?.classList.add('hidden');
        } else {
            legendPopulation?.classList.add('hidden');
            legendFossilPlants?.classList.remove('hidden');
        }
        showMapContainerOnly();
        const filteredPlants = baseLayer === 'plants'
            ? fossilPlants.filter(p => selectedFuelSet.has(p.fuel_group))
            : [];
        updatePopulationSimple(enriched, {
            baseLayer,
            selectedFuels: Array.from(selectedFuelSet),
            overlayMode,
            cfData: overlayMode === 'cf' ? cfFiltered : [],
            lcoeData: overlayMode === 'lcoe' && lcoeDisplay ? lcoeDisplay.resultsWithDelta : [],
            lcoeColorInfo: overlayMode === 'lcoe' ? lcoeDisplay?.colorInfo : null,
            targetCf: lcoeParams.targetCf,
            comparisonMetric,
            fossilPlants: filteredPlants,
            fossilCapacityMap: baseLayer === 'plants' ? fossilCapacityMap : null
        });
        if (baseLayer !== 'plants') {
            legendFossilPlants?.classList.add('hidden');
        }
    }
}

populationOverlayButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.dataset.overlay || 'none';
        if (mode === populationOverlayMode) return;
        populationOverlayMode = mode;
        updatePopulationOverlayToggleUI();
        updateChartOverlayToggleUI();
        updatePopulationOverlayControls(mode);
        if (mode === 'cf' || mode === 'lcoe') {
            populationChartMetric = mode;
            updateChartMetricToggleUI();
        }
        if (currentViewMode === 'population') {
            updatePopulationView();
        }
    });
});

populationBaseButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.dataset.base || 'population';
        if (mode === populationBaseLayer) return;
        setPopulationBaseLayer(mode);
    });
});

populationFuelButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const fuel = btn.dataset.fuel;
        if (!fuel) return;
        togglePopulationFuel(fuel);
    });
});

populationDisplayButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        setPopulationDisplayMode(btn.dataset.mode);
    });
});

populationChartMetricButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        setPopulationChartMetric(btn.dataset.metric);
    });
});

populationChartLayerButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        setPopulationBaseLayer(btn.dataset.layer);
    });
});

populationChartOverlayButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.dataset.overlay || 'none';
        if (mode === populationOverlayMode) return;
        populationOverlayMode = mode;
        updatePopulationOverlayToggleUI();
        updateChartOverlayToggleUI();
        updatePopulationOverlayControls(mode);
        if (mode === 'cf' || mode === 'lcoe') {
            populationChartMetric = mode;
            updateChartMetricToggleUI();
        }
        if (currentViewMode === 'population') {
            updatePopulationView();
        }
    });
});

viewModeChartSelect?.addEventListener('change', (e) => {
    const mode = e.target.value;
    if (mode && mode !== currentViewMode) {
        switchViewMode(mode);
    }
});

populationChartsCta?.addEventListener('click', () => {
    const nextMode = populationDisplayMode === 'charts' ? 'map' : 'charts';
    setPopulationDisplayMode(nextMode);
});

solarCapexInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.solarCapex = Math.max(0, val);
        queueLcoeUpdate();
    }
});

batteryCapexInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.batteryCapex = Math.max(0, val);
        queueLcoeUpdate();
    }
});

solarOpexInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.solarOpexPct = Math.max(0, val) / 100;
        queueLcoeUpdate();
    }
});

batteryOpexInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.batteryOpexPct = Math.max(0, val) / 100;
        queueLcoeUpdate();
    }
});

solarLifeInput.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (Number.isFinite(val)) {
        lcoeParams.solarLife = Math.max(1, val);
        queueLcoeUpdate();
    }
});

batteryLifeInput.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (Number.isFinite(val)) {
        lcoeParams.batteryLife = Math.max(1, val);
        queueLcoeUpdate();
    }
});

waccInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.wacc = Math.max(0, val) / 100;
        queueLcoeUpdate();
    }
});

comparisonButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (!lcoeReference) return;
        const mode = btn.dataset.mode;
        comparisonMetric = mode === 'tx' ? 'tx' : 'lcoe';
        updateComparisonToggleUI();
        refreshActiveLcoeView();
    });
});

clearRefBtn.addEventListener('click', () => {
    lcoeReference = null;
    comparisonMetric = 'lcoe';
    if (comparisonToggle) comparisonToggle.classList.add('hidden');
    clearRefBtn.classList.add('hidden');
    legendLock = false;
    lockedColorInfo = null;
    updateLegendLockButton();
    updateComparisonToggleUI();
    refreshActiveLcoeView();
});

legendLockBtn?.addEventListener('click', () => {
    if (!lcoeReference) return;
    legendLock = !legendLock;
    if (!legendLock) {
        lockedColorInfo = null;
        updateLegendLockButton();
        refreshActiveLcoeView();
    } else {
        lockedColorInfo = lastColorInfo;
        updateLegendLockButton();
        if (!lockedColorInfo) {
            refreshActiveLcoeView();
        } else {
            updateLcoeLegend(lcoeResults, lockedColorInfo);
        }
    }
});

// Start
init();
