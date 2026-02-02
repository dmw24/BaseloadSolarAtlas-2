/**
 * Scrollytelling Controller v2
 * Handles scroll observation, visual state synchronization, charts, and interactive annotations
 */

import { getVisualState, hasAnimation, getAnimation, interpolate } from './visual-states.js';
import { loadSummary, loadPopulationCsv, loadGemPlantsCsv, loadVoronoiGemCapacityCsv, loadElectricityDemandData, loadReliabilityCsv, loadSample, loadSampleColumnar, loadPvoutPotentialCsv, loadVoronoiWaccCsv, loadVoronoiLocalCapexCsv } from './data.js';
import { initMap, updateMap, updatePopulationSimple, updateLcoeMap, updateLcoePlantOverlay, updatePotentialMap, setAccessMetric, updateMapWithSampleFrame, clearAllMapLayers, map, initSampleFrameMap, updateSampleFrameColors, isSampleFrameInitialized, resetSampleFrameState, renderDualGlobes, hideDualGlobes } from './map.js';
import { capitalRecoveryFactor as crf } from './utils.js';
import { transitionController, initTransitions, TRANSITION_DURATION, interpolateColor } from './transitions.js';
import { showPopulationCfChart, showReliabilityChart, showFossilDisplacementChart, showWeeklySampleChart, showUptimeComparisonChart, showCumulativeCapacityChart, showNoAccessLcoeChart, showGlobalPopulationLcoeChart, hideChart } from './scrolly-charts.js';
import { POTENTIAL_MULTIPLE_BUCKETS } from './constants.js';

// ========== STATE ==========
let summaryData = [];
let populationData = [];
let fossilPlants = [];
let fossilCapacityData = [];
let fossilCapacityMap = null;
let reliabilityData = [];
let reliabilityMap = null;
let potentialData = [];
let potentialLatBounds = { level1: null, level2: null };
let electricityDemandMap = null;
let waccMap = new Map();
let localCapexMap = new Map();
let capexMode = 'global'; // 'global' or 'local'
let waccMode = 'global'; // 'global' or 'local'
let capexDataLoaded = false;
let waccDataLoaded = false;
let localCapexCache = new Map();
let localCapexCacheYear = null;
let lcoeOutlookYear = new Date().getFullYear();
let lcoeOutlookPlaying = false;
let lcoeOutlookInterval = null;
let lcoeOutlookMultipliers = { solar: 1, battery: 1 };
let weeklySampleData = null; // Weekly sample cache
let populationLoading = null;
let fossilLoading = null;
let reliabilityLoading = null;
let locationIndex = new Map();
let currentSection = null;
let isAnimating = false;
let animationFrame = null;
let animationTimer = null; // Track setTimeout for looping animations
let dataLinkOverride = null; // Tracks if a data-link click has temporarily overridden the view
let weeklyAnimationInterval = null;
let currentWeekFrame = 0;
let isAnimatingWeekly = false;
let currentSolarState = 6; // Default solar capacity
let preloadPromise = null;
let weeklySampleKey = null;
let weeklySampleLoading = null;
let weeklySampleRequestId = 0;
let lastLcoeResults = null;
let lastLcoeColorInfo = null;

// LCOE default parameters
const lcoeParams = {
    solarCapex: 600,
    batteryCapex: 120,
    solarOpexPct: 0.015,
    batteryOpexPct: 0.02,
    solarLife: 30,
    batteryLife: 20,
    wacc: 0.07
};
const DEFAULT_LCOE_TARGET_CF = 80;

// ========== DOM ELEMENTS ==========
const loadingOverlay = document.getElementById('loading');
const loadingStatus = document.getElementById('loading-status');
const visualLabel = document.getElementById('visual-label');
const visualLabelTitle = visualLabel?.querySelector('.visual-label-title');
const visualLabelSubtitle = visualLabel?.querySelector('.visual-label-subtitle');
const sectionDots = document.querySelectorAll('.section-dot');
const animationIndicator = document.getElementById('animation-indicator');
const animationValue = document.getElementById('animation-value');
const solarSlider = document.getElementById('solar-slider');
const solarValueDisplay = document.getElementById('solar-value-display');
const batterySlider = document.getElementById('battery-slider');
const mapElement = document.getElementById('map');

// Legend elements
const legendCapacity = document.getElementById('legend-capacity');
const legendLcoe = document.getElementById('legend-lcoe');
const legendLcoeMin = document.getElementById('legend-lcoe-min');
const legendLcoeMid = document.getElementById('legend-lcoe-mid');
const legendLcoeMax = document.getElementById('legend-lcoe-max');
const legendPopulation = document.getElementById('legend-population');
const legendAccess = document.getElementById('legend-access');
const legendUptime = document.getElementById('legend-uptime');
const legendWeekly = document.getElementById('legend-weekly');
const legendPotential = document.getElementById('legend-potential');
const legendPotentialBuckets = document.getElementById('legend-potential-buckets');

// LCOE Outlook controls
const outlookPanel = document.getElementById('lcoe-outlook-panel');
const outlookTitle = document.getElementById('lcoe-outlook-title');
const outlookPlayBtn = document.getElementById('lcoe-outlook-play');
const outlookSlider = document.getElementById('lcoe-outlook-slider');
const outlookYearLabel = document.getElementById('lcoe-outlook-year');
const outlookTimeline = document.getElementById('lcoe-outlook-timeline');
const outlookCapexButtons = document.querySelectorAll('#lcoe-outlook-capex-toggle button');
const outlookWaccButtons = document.querySelectorAll('#lcoe-outlook-wacc-toggle button');

// Target CF Slider elements
const targetCfContainer = document.getElementById('target-cf-container');
const inlineTargetCfContainer = document.getElementById('inline-target-cf-container');
const targetCfSlider = document.getElementById('target-cf-slider');
const targetCfDisplay = document.getElementById('target-cf-display');

// ========== INITIALIZATION ==========
async function init() {
    // Force scroll to top on refresh
    if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);

    updateLoadingStatus('Loading solar data...');

    try {
        // Load primary data
        summaryData = await loadSummary();
        console.log(`Loaded ${summaryData.length} summary rows`);

        // Build location index
        summaryData.forEach(row => {
            if (!locationIndex.has(row.location_id)) {
                locationIndex.set(row.location_id, []);
            }
            locationIndex.get(row.location_id).push(row);
        });

        updateLoadingStatus('Initializing map...');
        await initMap(onLocationSelect);

        // Store map reference globally for transitions
        window.scrollyMap = map;

        // Initialize transitions
        initTransitions();

        // Set up scroll observer
        setupScrollObserver();

        // Set up data-link click handlers
        setupDataLinkHandlers();

        // Set up interactions
        setupInteractions();
        updateOutlookToggleUI();

        // Scroll listener for fades
        window.addEventListener('scroll', handleScroll, { passive: true });

        // Hide loading overlay
        loadingOverlay.classList.add('hidden');

        // Initial render with hero state
        applyVisualState('hero');

        // Preload scrollytelling datasets in the background for smoother scrolling
        preloadScrollyData();

        // Ensure map is correctly sized and centered after layout settles
        setTimeout(() => {
            if (map) {
                map.invalidateSize();
                map.setView([20, 0], 2);
            }
        }, 100);

    } catch (error) {
        console.error('Initialization failed:', error);
        updateLoadingStatus('Error loading data. Please refresh.');
    }
}

async function preloadScrollyData() {
    if (preloadPromise) return preloadPromise;
    const batteryVal = batterySlider ? parseInt(batterySlider.value, 10) || 20 : 20;
    const solarVal = Number.isFinite(currentSolarState) ? currentSolarState : 6;

    preloadPromise = Promise.allSettled([
        ensurePopulationData(),
        ensureReliabilityData(),
        ensureFossilData(),
        ensurePotentialData(),
        ensureElectricityData(),
        updateWeeklyData(solarVal, batteryVal, { silent: true })
    ]).catch((err) => {
        console.warn('Preload failed:', err);
    });

    return preloadPromise;
}

// ========== LAZY DATA LOADERS ==========

async function ensurePopulationData() {
    if (populationData && populationData.length > 0) return;
    if (populationLoading) return populationLoading;

    populationLoading = (async () => {
        updateLoadingStatus('Loading population data...');
        try {
            populationData = await loadPopulationCsv();
            console.log(`Loaded ${populationData.length} population rows`);

            // Add location_id to population data based on coordinates matching
            const summaryCoordIndex = new Map();
            summaryData.forEach(row => {
                const key = `${row.latitude.toFixed(4)},${row.longitude.toFixed(4)}`;
                if (!summaryCoordIndex.has(key)) {
                    summaryCoordIndex.set(key, row);
                }
            });

            populationData.forEach(pop => {
                const key = `${pop.latitude.toFixed(4)},${pop.longitude.toFixed(4)}`;
                const match = summaryCoordIndex.get(key);
                if (match) {
                    pop.location_id = match.location_id;
                }
            });
            updateLoadingStatus('');
        } catch (error) {
            console.warn('Failed to load population data:', error);
        } finally {
            populationLoading = null;
        }
    })();

    return populationLoading;
}

async function ensureFossilData() {
    if (fossilPlants && fossilPlants.length > 0) return;
    if (fossilLoading) return fossilLoading;

    fossilLoading = (async () => {
        updateLoadingStatus('Loading fossil fuel data...');
        try {
            fossilPlants = await loadGemPlantsCsv();
            fossilCapacityData = await loadVoronoiGemCapacityCsv();
            fossilCapacityMap = new Map();
            fossilCapacityData.forEach(row => {
                fossilCapacityMap.set(row.location_id, {
                    coal_mw: row.coal_Existing || 0,
                    oil_gas_mw: row.oil_gas_Existing || 0,
                    bioenergy_mw: row.bioenergy_Existing || 0,
                    nuclear_mw: row.nuclear_Existing || 0,
                    // Add Announced fields for map overlay
                    coal_Announced: row.coal_Announced || 0,
                    oil_gas_Announced: row.oil_gas_Announced || 0,
                    bioenergy_Announced: row.bioenergy_Announced || 0,
                    nuclear_Announced: row.nuclear_Announced || 0
                });
            });
            if (fossilPlants.length && fossilCapacityData.length && window.d3?.Delaunay) {
                const sites = fossilCapacityData.map(d => [d.latitude, d.longitude]);
                const delaunay = window.d3.Delaunay.from(sites);
                fossilPlants.forEach(plant => {
                    if (!Number.isFinite(plant.latitude) || !Number.isFinite(plant.longitude)) return;
                    const idx = delaunay.find(plant.latitude, plant.longitude);
                    if (idx !== -1 && fossilCapacityData[idx]) {
                        plant.location_id = fossilCapacityData[idx].location_id;
                    }
                });
            }
            updateLoadingStatus('');
        } catch (error) {
            console.warn('Failed to load fossil data:', error);
        } finally {
            fossilLoading = null;
        }
    })();

    return fossilLoading;
}

async function ensureReliabilityData() {
    if (reliabilityData && reliabilityData.length > 0) return;
    if (reliabilityLoading) return reliabilityLoading;

    reliabilityLoading = (async () => {
        updateLoadingStatus('Loading reliability data...');
        try {
            reliabilityData = await loadReliabilityCsv();
            reliabilityMap = new Map();
            reliabilityData.forEach(row => {
                reliabilityMap.set(row.location_id, row);
            });
            updateLoadingStatus('');
        } catch (error) {
            console.warn('Failed to load reliability data:', error);
        } finally {
            reliabilityLoading = null;
        }
    })();

    return reliabilityLoading;
}

async function ensurePotentialData() {
    if (potentialData && potentialData.length > 0) return;
    updateLoadingStatus('Loading solar potential data...');
    try {
        potentialData = await loadPvoutPotentialCsv();
        updateLoadingStatus('');
    } catch (error) {
        console.warn('Failed to load potential data:', error);
    }
}

function ensurePotentialLatBounds(level = 'level1') {
    if (potentialLatBounds[level]) return potentialLatBounds[level];
    const dataKey = level === 'level2' ? 'pvout_level2_data_area_km2' : 'pvout_level1_data_area_km2';
    let minLat = Infinity;
    let maxLat = -Infinity;
    potentialData.forEach(row => {
        const dataArea = Number(row[dataKey] || 0);
        const lat = Number(row.latitude);
        if (!Number.isFinite(lat) || dataArea <= 0) return;
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    });
    if (Number.isFinite(minLat) && Number.isFinite(maxLat)) {
        potentialLatBounds[level] = { min: minLat, max: maxLat };
    }
    return potentialLatBounds[level];
}

async function ensureElectricityData() {
    if (electricityDemandMap && electricityDemandMap.size > 0) return;
    updateLoadingStatus('Loading electricity demand data...');
    try {
        const demandRows = await loadElectricityDemandData();
        electricityDemandMap = new Map();
        demandRows.forEach(row => {
            electricityDemandMap.set(row.location_id, row);
        });
        updateLoadingStatus('');
    } catch (error) {
        console.warn('Failed to load electricity demand data:', error);
    }
}

async function ensureWaccData() {
    if (waccDataLoaded) return true;
    updateLoadingStatus('Loading local WACC data...');
    try {
        const rows = await loadVoronoiWaccCsv();
        waccMap = new Map();
        rows.forEach(row => {
            const waccPercent = Number(row.wacc_percent);
            if (!Number.isFinite(row.location_id) || !Number.isFinite(waccPercent)) return;
            waccMap.set(row.location_id, waccPercent / 100);
        });
        waccDataLoaded = true;
        updateLoadingStatus('');
        return true;
    } catch (error) {
        console.warn('Failed to load WACC data:', error);
        waccDataLoaded = false;
        return false;
    }
}

async function ensureLocalCapexData() {
    if (capexDataLoaded) return true;
    updateLoadingStatus('Loading local CAPEX data...');
    try {
        const rows = await loadVoronoiLocalCapexCsv();
        localCapexMap = new Map();
        rows.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const values = [
                row.solar_2024, row.solar_2035, row.solar_2050,
                row.battery_2024, row.battery_2035, row.battery_2050
            ];
            if (!values.every(Number.isFinite)) return;
            localCapexMap.set(row.location_id, {
                solar: [row.solar_2024, row.solar_2035, row.solar_2050],
                battery: [row.battery_2024, row.battery_2035, row.battery_2050]
            });
        });
        capexDataLoaded = true;
        resetLocalCapexCache();
        updateLoadingStatus('');
        return true;
    } catch (error) {
        console.warn('Failed to load local CAPEX data:', error);
        capexDataLoaded = false;
        return false;
    }
}

function updateLoadingStatus(message) {
    if (loadingStatus) {
        loadingStatus.textContent = message;
    }
}

const LCOE_OUTLOOK_ANCHORS = (() => {
    const baseYear = new Date().getFullYear();
    return {
        baseYear,
        solar: [
            { year: baseYear, factor: 1.0 },
            { year: 2035, factor: 0.61 },
            { year: 2050, factor: 0.50 }
        ],
        battery: [
            { year: baseYear, factor: 1.0 },
            { year: 2035, factor: 0.66 },
            { year: 2050, factor: 0.55 }
        ]
    };
})();

function interpolateFactor(year, anchors) {
    if (!anchors?.length) return 1;
    if (year <= anchors[0].year) return anchors[0].factor;
    for (let i = 0; i < anchors.length - 1; i += 1) {
        const a = anchors[i];
        const b = anchors[i + 1];
        if (year <= b.year) {
            const t = (year - a.year) / (b.year - a.year || 1);
            return a.factor + t * (b.factor - a.factor);
        }
    }
    return anchors[anchors.length - 1].factor;
}

function resetLocalCapexCache() {
    localCapexCache.clear();
    localCapexCacheYear = null;
}

function interpolateLocalCapex(year, values) {
    if (!Array.isArray(values) || values.length < 3) return null;
    const [v2024, v2035, v2050] = values;
    if (![v2024, v2035, v2050].every(Number.isFinite)) return null;
    if (year <= 2024) return v2024;
    if (year >= 2050) return v2050;
    if (year <= 2035) {
        return v2024 + ((v2035 - v2024) * (year - 2024)) / (2035 - 2024);
    }
    return v2035 + ((v2050 - v2035) * (year - 2035)) / (2050 - 2035);
}

function getLocalCapex(locationId) {
    if (capexMode !== 'local' || !localCapexMap.size) return null;
    if (localCapexCacheYear !== lcoeOutlookYear) {
        localCapexCacheYear = lcoeOutlookYear;
        localCapexCache.clear();
    }
    if (localCapexCache.has(locationId)) {
        return localCapexCache.get(locationId);
    }
    const entry = localCapexMap.get(locationId);
    if (!entry) {
        localCapexCache.set(locationId, null);
        return null;
    }
    const solar = interpolateLocalCapex(lcoeOutlookYear, entry.solar);
    const battery = interpolateLocalCapex(lcoeOutlookYear, entry.battery);
    if (!Number.isFinite(solar) || !Number.isFinite(battery)) {
        localCapexCache.set(locationId, null);
        return null;
    }
    const payload = { solar, battery };
    localCapexCache.set(locationId, payload);
    return payload;
}

function getLocalWacc(locationId) {
    if (waccMode !== 'local' || !waccMap.size) return null;
    const wacc = waccMap.get(locationId);
    return Number.isFinite(wacc) ? wacc : null;
}

function updateOutlookToggleUI() {
    outlookCapexButtons.forEach(btn => {
        const isActive = btn.dataset.mode === capexMode;
        btn.classList.toggle('bg-gray-600', isActive);
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('shadow-sm', isActive);
        btn.classList.toggle('text-gray-400', !isActive);
        btn.classList.toggle('hover:text-white', !isActive);
    });
    outlookWaccButtons.forEach(btn => {
        const isActive = btn.dataset.mode === waccMode;
        btn.classList.toggle('bg-gray-600', isActive);
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('shadow-sm', isActive);
        btn.classList.toggle('text-gray-400', !isActive);
        btn.classList.toggle('hover:text-white', !isActive);
    });
}

async function setCapexMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (capexMode === normalized) return;
    capexMode = normalized;
    updateOutlookToggleUI();
    resetLocalCapexCache();
    if (capexMode === 'local') {
        await ensureLocalCapexData();
    }
    await refreshLcoeViews();
}

async function setWaccMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (waccMode === normalized) return;
    waccMode = normalized;
    updateOutlookToggleUI();
    if (waccMode === 'local') {
        await ensureWaccData();
    }
    await refreshLcoeViews();
}

async function refreshLcoeViews() {
    if (!currentSection) return;
    if (currentSection === 'lcoe-outlook') {
        updateLcoeOutlookMap();
        return;
    }

    const state = getVisualState(currentSection);
    if (!state) return;

    if (currentSection === 'cheap-populous') {
        await ensurePopulationData();
        const targetCf = (state.targetCf || DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        lastLcoeResults = lcoeResults;
        lastLcoeColorInfo = colorInfo;
        updateLcoeMap(lcoeResults, { colorInfo });
        updateLegend('lcoe');
        await showGlobalPopulationLcoeChart(populationData, lcoeResults);
        return;
    }

    if (state.viewMode === 'lcoe') {
        if (currentSection === 'planned-capacity') {
            await ensureFossilData();
        }

        const targetCf = (state.targetCf || DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        lastLcoeResults = lcoeResults;
        lastLcoeColorInfo = colorInfo;
        const options = { colorInfo };

        if (currentSection === 'planned-capacity') {
            options.fossilPlants = fossilPlants;
            options.fossilCapacityMap = fossilCapacityMap;
        }

        updateLcoeMap(lcoeResults, options);
        updateLegend('lcoe');

        if (currentSection === 'planned-capacity' && fossilCapacityData.length > 0) {
            await showCumulativeCapacityChart(fossilCapacityData, lcoeResults);
        }
    }
}

window.updatePlannedCapacityOverlay = (locationIds) => {
    if (currentSection !== 'planned-capacity') return;
    if (!lastLcoeResults || !lastLcoeColorInfo) return;
    let filteredPlants = fossilPlants;
    if (Array.isArray(locationIds) && locationIds.length) {
        const idSet = new Set(locationIds.map(id => Number(id)));
        filteredPlants = fossilPlants.filter(p => idSet.has(Number(p.location_id)));
    }
    updateLcoePlantOverlay(filteredPlants);
};

function applyOutlookYear(year, { triggerUpdate = true } = {}) {
    const normalizedYear = Math.max(LCOE_OUTLOOK_ANCHORS.baseYear, Math.min(2050, year));
    lcoeOutlookYear = normalizedYear;
    lcoeOutlookMultipliers.solar = interpolateFactor(normalizedYear, LCOE_OUTLOOK_ANCHORS.solar);
    lcoeOutlookMultipliers.battery = interpolateFactor(normalizedYear, LCOE_OUTLOOK_ANCHORS.battery);
    resetLocalCapexCache();
    if (outlookYearLabel) outlookYearLabel.textContent = normalizedYear;
    if (outlookSlider) outlookSlider.value = normalizedYear;
    if (triggerUpdate && currentSection === 'lcoe-outlook') {
        updateLcoeOutlookMap();
    }
}

function stopOutlookAnimation() {
    if (lcoeOutlookInterval) {
        clearInterval(lcoeOutlookInterval);
        lcoeOutlookInterval = null;
    }
    lcoeOutlookPlaying = false;
    if (outlookPlayBtn) outlookPlayBtn.textContent = 'Play';
}

function startOutlookAnimation() {
    stopOutlookAnimation();
    lcoeOutlookPlaying = true;
    if (outlookPlayBtn) outlookPlayBtn.textContent = 'Pause';
    if (lcoeOutlookYear >= 2050) {
        applyOutlookYear(LCOE_OUTLOOK_ANCHORS.baseYear);
    }
    lcoeOutlookInterval = setInterval(() => {
        if (lcoeOutlookYear >= 2050) {
            stopOutlookAnimation();
            return;
        }
        applyOutlookYear(lcoeOutlookYear + 1);
    }, 650);
}

function updateLcoeOutlookMap() {
    const targetCf = DEFAULT_LCOE_TARGET_CF / 100;
    const lcoeResults = computeLcoeForAllLocations(targetCf);
    const colorInfo = buildLcoeColorInfo(lcoeResults);
    lastLcoeResults = lcoeResults;
    lastLcoeColorInfo = colorInfo;
    updateLcoeMap(lcoeResults, { colorInfo });
    updateLegend('lcoe');
    updateVisualLabel({ title: 'LCOE Outlook', subtitle: `Target: ${DEFAULT_LCOE_TARGET_CF}% Capacity Factor • ${lcoeOutlookYear}` });
}

async function onLocationSelect(data, mode) {
    console.log('Location selected:', data, mode);

    // Section 3: Batteries Make the Sun Shine After Dark
    if (currentSection === 'battery-shadow' && weeklySampleData) {
        // Find the sample data for this location
        // data.location_id comes from the click event
        const locationId = Number(data.location_id);
        const targetLoc = weeklySampleData.find(d => Number(d.location_id) === locationId);

        if (targetLoc) {
            let locationName = `Location ${locationId}`;
            const summaryRow = summaryData.find(d => Number(d.location_id) === Number(locationId));
            if (summaryRow && summaryRow.country) {
                locationName = `${summaryRow.country} (ID: ${locationId})`;
            }

            // Transform Vector data to Time-Step Array for Chart
            const toArray = (field) => {
                if (!field) return [];
                if (Array.isArray(field)) return field;
                if (typeof field.toArray === 'function') return field.toArray();
                return Array.from(field);
            };

            const solar = toArray(targetLoc.solar_gen);
            const batt = toArray(targetLoc.battery_flow);
            const unserved = toArray(targetLoc.unserved_load || targetLoc.unserved);
            const soc = toArray(targetLoc.state_of_charge || targetLoc.soc);

            const chartData = solar.map((s, i) => ({
                solar_gen: s,
                battery_flow: batt[i] || 0,
                unserved: unserved[i] || 0,
                soc: soc[i] || 0
            }));

            console.log(`Updating weekly chart for ${locationName}`);
            await showWeeklySampleChart(chartData, locationName);
            // Re-show legend if it was hidden by chart? No, scrolly-visual keeps it.
        }
    }
}

// ========== SCROLL OBSERVER ==========
function setupScrollObserver() {
    const sections = document.querySelectorAll('.scrolly-section, .scrolly-hero');

    const observerOptions = {
        root: null,
        rootMargin: '-30% 0px -30% 0px',
        threshold: 0
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const sectionId = entry.target.dataset.section;
                if (sectionId && sectionId !== currentSection) {
                    onSectionEnter(sectionId);
                }
                entry.target.classList.add('visible', 'active');
            } else {
                entry.target.classList.remove('active');
            }
        });
    }, observerOptions);

    sections.forEach(section => {
        observer.observe(section);
    });

    // Click handlers for section dots
    sectionDots.forEach((dot, index) => {
        dot.addEventListener('click', () => {
            const targetSection = document.getElementById(`section-${index + 1}`);
            if (targetSection) {
                targetSection.scrollIntoView({ behavior: 'smooth' });
            }
        });
    });
}

function onSectionEnter(sectionId) {
    console.log('Entering section:', sectionId);

    // STOP ALL ANIMATIONS IMMEDIATELY
    stopAnimations();

    currentSection = sectionId;

    // Clear any data-link override when scrolling to a new section
    if (dataLinkOverride) {
        dataLinkOverride = null;
        document.querySelectorAll('.data-link.active').forEach(el => el.classList.remove('active'));
    }

    // Stop weekly animation if leaving Step 3
    if (sectionId !== 'battery-shadow') {
        stopWeeklyAnimation();
    }

    updateSectionDots(sectionId);

    // Reset solar to default for section 2 if entering afresh? 
    // Or keep user selection? Let's keep it simple and sync if needed.
    if (sectionId === 'battery-capacity') {
        const state = getVisualState(sectionId);
        // Ensure slider matches state or current
        if (solarSlider) {
            // If we want to persist user choice, do nothing. 
            // If we want to reset to defaults:
            // solarSlider.value = state.solar;
            // currentSolarState = state.solar;
            // solarValueDisplay.textContent = state.solar;
        }
    }

    applyVisualState(sectionId);
}

function setupInteractions() {
    // Debounce timer for slider data loading
    let sliderDebounceTimer = null;
    const DEBOUNCE_DELAY = 300; // ms

    // Helper to show/hide loading state on sliders
    const setSliderLoading = (loading) => {
        const indicator = document.getElementById('animation-indicator');
        if (indicator) {
            if (loading) {
                indicator.style.opacity = '0.5';
                indicator.classList.add('loading');
            } else {
                indicator.style.opacity = '1';
                indicator.classList.remove('loading');
            }
        }
    };

    if (solarSlider) {
        // Use 'change' event for actual data reloading with debouncing
        solarSlider.addEventListener('change', async (e) => {
            const val = parseInt(e.target.value, 10);
            if (currentSection === 'battery-shadow') {
                // Clear any pending debounce
                if (sliderDebounceTimer) clearTimeout(sliderDebounceTimer);

                sliderDebounceTimer = setTimeout(async () => {
                    // Show loading state but keep animation running
                    setSliderLoading(true);

                    // Load new data in background
                    await updateWeeklyData(val, batterySlider ? parseInt(batterySlider.value, 10) : 20);

                    // Reinitialize with new data
                    if (weeklySampleData) {
                        stopWeeklyAnimation(); // This resets state
                        startWeeklyAnimation(); // This will reinitialize with new data
                    }

                    setSliderLoading(false);
                }, DEBOUNCE_DELAY);
            }
        });

        solarSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            currentSolarState = val;
            if (solarValueDisplay) solarValueDisplay.textContent = val;
        });
    }

    if (batterySlider) {
        batterySlider.addEventListener('change', async (e) => {
            const val = parseInt(e.target.value, 10);
            if (currentSection === 'battery-shadow') {
                // Clear any pending debounce
                if (sliderDebounceTimer) clearTimeout(sliderDebounceTimer);

                sliderDebounceTimer = setTimeout(async () => {
                    // Show loading state but keep animation running
                    setSliderLoading(true);

                    // Load new data in background
                    await updateWeeklyData(currentSolarState, val);

                    // Reinitialize with new data
                    if (weeklySampleData) {
                        stopWeeklyAnimation();
                        startWeeklyAnimation();
                    }

                    setSliderLoading(false);
                }, DEBOUNCE_DELAY);
            }
        });

        batterySlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (animationValue) animationValue.textContent = val;
        });
    }

    if (targetCfSlider) {
        targetCfSlider.addEventListener('input', async (e) => {
            const val = parseInt(e.target.value, 10);
            if (targetCfDisplay) targetCfDisplay.textContent = val;

            if (currentSection === 'planned-capacity') {
                // Re-calculate LCOE and update map/chart in real-time
                const targetCf = val / 100.0;
                const lcoeResults = computeLcoeForAllLocations(targetCf);

                // Update Map
                const colorInfo = buildLcoeColorInfo(lcoeResults);
                lastLcoeResults = lcoeResults;
                lastLcoeColorInfo = colorInfo;
                updateLcoeMap(lcoeResults, { colorInfo, fossilCapacityMap, fossilPlants });
                updateVisualLabel({ title: 'LCOE Map', subtitle: `Target: ${val}% Capacity Factor` });

                // Update Chart
                await showCumulativeCapacityChart(fossilCapacityData, lcoeResults);
            } else if (currentSection === 'cheap-access') {
                const targetCfValue = val;
                const lcoeResults = computeLcoeForAllLocations(targetCfValue / 100);
                const colorInfo = buildLcoeColorInfo(lcoeResults);

                updatePopulationSimple(populationData, {
                    baseLayer: 'access',
                    overlayMode: 'none',
                    lcoeData: [],
                    reliabilityData,
                    reliabilityMap,
                    accessMetric: 'no_access_pop'
                });

                await showNoAccessLcoeChart(reliabilityData, locationIndex, lcoeParams, targetCfValue);
            }
        });
    }

    if (outlookSlider) {
        outlookSlider.min = LCOE_OUTLOOK_ANCHORS.baseYear;
        outlookSlider.max = 2050;
        outlookSlider.value = LCOE_OUTLOOK_ANCHORS.baseYear;
        applyOutlookYear(LCOE_OUTLOOK_ANCHORS.baseYear, { triggerUpdate: false });
        outlookSlider.addEventListener('input', (e) => {
            const year = parseInt(e.target.value, 10);
            applyOutlookYear(Number.isFinite(year) ? year : LCOE_OUTLOOK_ANCHORS.baseYear);
        });
    }

    if (outlookPlayBtn) {
        outlookPlayBtn.addEventListener('click', () => {
            if (lcoeOutlookPlaying) {
                stopOutlookAnimation();
            } else {
                startOutlookAnimation();
            }
        });
    }

    if (outlookCapexButtons && outlookCapexButtons.length) {
        outlookCapexButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setCapexMode(btn.dataset.mode);
            });
        });
    }

    if (outlookWaccButtons && outlookWaccButtons.length) {
        outlookWaccButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setWaccMode(btn.dataset.mode);
            });
        });
    }
}



function updateSectionDots(sectionId) {
    const sectionIndex = getSectionIndex(sectionId);
    sectionDots.forEach((dot, index) => {
        dot.classList.toggle('active', index === sectionIndex);
    });
}

function getSectionIndex(sectionId) {
    const map = {
        'hero': -1,
        'potential-map': 0,
        'battery-shadow': 1,
        'battery-capacity': 2,
        'widespread': 3,
        'cheap-populous': 4,
        'cheap-access': 5,
        'better-uptime': 6,
        'planned-capacity': 7,
        'lcoe-outlook': 8,
        'path-forward': 9
    };
    return map[sectionId] ?? -1;
}

// ========== DATA-LINK HANDLERS ==========
function setupDataLinkHandlers() {
    const dataLinks = document.querySelectorAll('.data-link');

    dataLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            handleDataLinkClick(link);
        });
    });
}

async function handleDataLinkClick(link) {
    const chartType = link.dataset.chart;
    const view = link.dataset.view;
    const stat = link.dataset.stat;

    // Mark this link as active
    document.querySelectorAll('.data-link.active').forEach(el => el.classList.remove('active'));
    link.classList.add('active');
    dataLinkOverride = { chartType, view, stat };

    console.log('Data link clicked:', { chartType, view, stat });

    // Apply crossfade effect
    if (mapElement) {
        mapElement.style.opacity = '0.6';
    }

    // Handle different chart types
    if (chartType === 'population-cf') {
        const cfData = summaryData.filter(d => d.solar_gw === 5 && d.batt_gwh === 8);
        await showPopulationCfChart(populationData, cfData);
        updateVisualLabel({ title: 'Population Distribution', subtitle: 'By Capacity Factor Percentile' });
    } else if (chartType === 'fossil-displacement') {
        const cfData = summaryData.filter(d => d.solar_gw === 6 && d.batt_gwh === 20);
        await showFossilDisplacementChart(fossilCapacityData, cfData, ['coal']);
        updateVisualLabel({ title: 'Coal Displacement Potential', subtitle: 'Capacity by CF Viability' });
    } else if (view === 'lcoe') {
        hideChart();
        const targetCf = DEFAULT_LCOE_TARGET_CF / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        updateLcoeMap(lcoeResults, { colorInfo, fossilPlants });
        updateLegend('lcoe');
        updateVisualLabel({ title: 'LCOE Map', subtitle: `Target: ${DEFAULT_LCOE_TARGET_CF}% Capacity Factor` });
    } else if (link.dataset.section) {
        // Manual navigation link inside text
        const target = document.querySelector(`[data-section="${link.dataset.section}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth' });
    }

    // Fade map back in
    setTimeout(() => {
        if (mapElement) {
            mapElement.style.opacity = '1';
        }
    }, TRANSITION_DURATION);
}

// ========== VISUAL STATE APPLICATION ==========
async function applyVisualState(sectionId) {
    const state = getVisualState(sectionId);
    if (!state) return;

    console.log('Applying visual state:', sectionId, state);

    const showCostPanel = sectionId === 'lcoe-outlook' || sectionId === 'cheap-populous';
    if (!showCostPanel) {
        stopOutlookAnimation();
        capexMode = 'global';
        waccMode = 'global';
        updateOutlookToggleUI();
        applyOutlookYear(LCOE_OUTLOOK_ANCHORS.baseYear, { triggerUpdate: false });
        if (outlookPanel) outlookPanel.classList.add('hidden');
    } else {
        if (outlookPanel) {
            outlookPanel.classList.remove('hidden');
            if (sectionId === 'cheap-populous') {
                stopOutlookAnimation();
                capexMode = 'global';
                waccMode = 'global';
                updateOutlookToggleUI();
                applyOutlookYear(LCOE_OUTLOOK_ANCHORS.baseYear, { triggerUpdate: false });
                outlookPanel.classList.add('compact');
                if (outlookTitle) outlookTitle.textContent = 'Cost Assumptions';
            } else {
                outlookPanel.classList.remove('compact');
                if (outlookTitle) outlookTitle.textContent = 'LCOE Outlook';
            }
        }
    }

    // Ensure necessary data is loaded before rendering map
    if (sectionId === 'cheap-populous') {
        await ensurePopulationData();
    } else if (sectionId === 'cheap-access' || sectionId === 'better-uptime') {
        await ensureReliabilityData();
    } else if (sectionId === 'planned-capacity') {
        await ensureFossilData();
    } else if (sectionId === 'potential-map') {
        await ensurePotentialData();
        await ensureElectricityData();
        ensurePotentialLatBounds(state.level || 'level1');
    }

    // Update label
    updateVisualLabel(state.label);

    // Update legend visibility
    updateLegend(state.legend);

    // Handle chart visibility based on section
    await handleSectionCharts(sectionId, state);

    // Check for animation
    if (hasAnimation(sectionId) && !isAnimating) {
        runAnimation(sectionId, state);
    } else if (!isAnimating) {
        // Apply crossfade transition
        transitionController.crossfade(() => {
            renderVisualState(state);
        });
    }
}

async function handleSectionCharts(sectionId, state) {
    // Hide chart by default
    let showChart = false;

    // Always ensure animation is stopped if not in the correct section
    if (sectionId !== 'battery-shadow') {
        stopWeeklyAnimation();
        const ind = document.getElementById('animation-indicator');
        if (ind) ind.classList.add('hidden');
    }

    if (sectionId !== 'lcoe-outlook' && sectionId !== 'cheap-populous') {
        stopOutlookAnimation();
        if (outlookPanel) outlookPanel.classList.add('hidden');
    }

    // Hide Target CF slider by default
    if (sectionId !== 'planned-capacity' && targetCfContainer) {
        targetCfContainer.classList.add('hidden');
    }
    if (inlineTargetCfContainer) {
        inlineTargetCfContainer.classList.add('hidden');
    }

    // Hide dual globe container when not in Step 4
    if (sectionId !== 'cheap-populous') {
        hideDualGlobes();
    }

    // Section 3: Batteries Make the Sun Shine After Dark
    if (sectionId === 'battery-shadow') {
        // Ensure strictly clear map state before starting animation logic
        clearAllMapLayers();

        // Ensure UI indicator is visible
        const ind = document.getElementById('animation-indicator');
        if (ind) ind.classList.remove('hidden');
        if (targetCfContainer) targetCfContainer.classList.add('hidden');
        if (inlineTargetCfContainer) inlineTargetCfContainer.classList.add('hidden');

        if (ind) ind.classList.remove('hidden');

        if (!weeklySampleData) {
            const batteryVal = batterySlider ? parseInt(batterySlider.value, 10) : 20;
            await updateWeeklyData(currentSolarState, batteryVal);
        }

        if (currentSection !== sectionId) return;

        if (weeklySampleData && weeklySampleData.length > 0) {
            // Start map animation
            startWeeklyAnimation();
        } else {
            console.error("Weekly sample data is empty or failed to load");
        }
    }
    // Section 5: High-uptime solar is cheapest where people live
    else if (sectionId === 'cheap-populous') {
        hideDualGlobes();
        await ensurePopulationData();
        const state = getVisualState('cheap-populous');
        const targetCf = (state.targetCf || DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        showChart = true;
        await showGlobalPopulationLcoeChart(populationData, lcoeResults);
        if (currentSection !== sectionId) hideChart();
    }
    // Section 5: Cheap Where Access is Lacking
    else if (sectionId === 'cheap-access') {
        await ensureReliabilityData();
        if (reliabilityData.length > 0) {
            showChart = true;
            await showReliabilityChart(reliabilityData);
            if (currentSection !== sectionId) hideChart();
        }
    }
    // Section 6: Better Uptime
    else if (sectionId === 'better-uptime') {
        await ensureReliabilityData();
        if (reliabilityData.length > 0) {
            showChart = true;
            await showUptimeComparisonChart(reliabilityData, locationIndex, lcoeParams);
            if (currentSection !== sectionId) hideChart();
        }
    }
    // Section 7: Planned Capacity
    else if (sectionId === 'planned-capacity') {
        await ensureFossilData();

        if (targetCfContainer) targetCfContainer.classList.remove('hidden');
        if (inlineTargetCfContainer) inlineTargetCfContainer.classList.remove('hidden');

        const plannedTargetCf = getVisualState('planned-capacity')?.targetCf ?? DEFAULT_LCOE_TARGET_CF;
        if (targetCfSlider) {
            targetCfSlider.value = plannedTargetCf;
            if (targetCfDisplay) targetCfDisplay.textContent = plannedTargetCf;
        }

        if (fossilCapacityData.length > 0) {
            showChart = true;

            // Get current slider value
            const sliderVal = targetCfSlider ? parseInt(targetCfSlider.value, 10) : plannedTargetCf;
            const targetCf = sliderVal / 100.0;

            // Compute LCOE
            const lcoeResults = computeLcoeForAllLocations(targetCf);

            // Update Map here explicitly or just rely on applyVisualState calling renderVisualState?
            // renderVisualState is called after this function in applyVisualState via transitionController.
            // But renderVisualState logic for 'planned-capacity' needs to be defined below.
            // Currently 'planned-capacity' viewMode is not explicitly handled in renderVisualState?
            // Check visual-states.js for 'planned-capacity' viewMode. It is likely 'lcoe' or 'population'?
            // Assuming we need to override the map update here or ensure renderVisualState handles it.
            // Let's look at applyVisualState: it calls renderVisualState(state).
            // We need to ensure state.viewMode corresponds to what we want.

            // Render Chart
            await showCumulativeCapacityChart(fossilCapacityData, lcoeResults);
            if (currentSection !== sectionId) hideChart();
        }
    }
    // Section 9: LCOE Outlook
    else if (sectionId === 'lcoe-outlook') {
        if (outlookPanel) outlookPanel.classList.remove('hidden');
        updateOutlookToggleUI();
        applyOutlookYear(lcoeOutlookYear, { triggerUpdate: false });
        updateLcoeOutlookMap();
        startOutlookAnimation();
    }

    if (!showChart) {
        hideChart();
    }
}

function updateVisualLabel(label) {
    if (!label) return;
    if (visualLabelTitle) visualLabelTitle.textContent = label.title || '';
    if (visualLabelSubtitle) visualLabelSubtitle.textContent = label.subtitle || '';

    // If both are empty, hide the label container or ensure it's visually empty
    if (visualLabel && !label.title && !label.subtitle) {
        visualLabel.classList.add('hidden');
    } else if (visualLabel) {
        visualLabel.classList.remove('hidden');
    }
}

function updateLegend(legendType) {
    // Hide all legends
    [legendCapacity, legendLcoe, legendPopulation, legendAccess, legendUptime, legendWeekly, legendPotential].forEach(el => {
        if (el) el.classList.add('hidden');
    });

    const legendMap = {
        'capacity': legendCapacity,
        'lcoe': legendLcoe,
        'population': legendPopulation,
        'access': legendAccess,
        'uptime': legendUptime,
        'weekly': legendWeekly,
        'potential': legendPotential
    };

    const targetLegend = legendMap[legendType];
    if (targetLegend) {
        targetLegend.classList.remove('hidden');
    }

    if (legendType === 'potential' && legendPotentialBuckets) {
        const noData = `<div class=\"flex items-center gap-2\"><span class=\"w-3 h-3 rounded-sm\" style=\"background:#6b7280\"></span><span>No data</span></div>`;
        const items = POTENTIAL_MULTIPLE_BUCKETS.map(bucket => (
            `<div class=\"flex items-center gap-2\"><span class=\"w-3 h-3 rounded-sm\" style=\"background:${bucket.color}\"></span><span>${bucket.label}</span></div>`
        ));
        legendPotentialBuckets.innerHTML = `${items.join('')}${noData}`;
    }

    if (legendType === 'lcoe') {
        if (legendLcoeMin) legendLcoeMin.textContent = '$0';
        if (legendLcoeMid) legendLcoeMid.textContent = '$100';
        if (legendLcoeMax) legendLcoeMax.textContent = '$200';
    }
}

function renderVisualState(state) {
    const { viewMode } = state;

    if (viewMode === 'capacity') {
        const solar = state.solar || 5;
        const battery = state.battery || 8;
        updateMap(summaryData, solar, battery, state.mapOptions || {});

    } else if (viewMode === 'potential') {
        const level = state.level || 'level1';
        const displayMode = state.displayMode || 'multiple';
        const latBounds = potentialLatBounds[level] || ensurePotentialLatBounds(level) || null;
        updatePotentialMap(potentialData, { level, displayMode, demandMap: electricityDemandMap, latBounds });

    } else if (viewMode === 'lcoe') {
        const targetCf = (state.targetCf || DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        lastLcoeResults = lcoeResults;
        lastLcoeColorInfo = colorInfo;
        let options = { colorInfo };
        if (state.overlayPlants === 'announced') {
            options.fossilPlants = fossilPlants;
            options.fossilCapacityMap = fossilCapacityMap;
        }

        updateLcoeMap(lcoeResults, options);

    } else if (viewMode === 'population') {
        const { baseLayer, overlayMode, solar, battery, selectedFuels, selectedStatus } = state;

        let cfData = [];
        if (overlayMode === 'cf' && solar && battery) {
            cfData = summaryData.filter(d => d.solar_gw === solar && d.batt_gwh === battery);
        }

        if (baseLayer === 'access') {
            setAccessMetric('reliability');
        }

        updatePopulationSimple(populationData, {
            baseLayer: baseLayer || 'population',
            overlayMode: overlayMode || 'none',
            cfData,
            lcoeData: [],
            fossilPlants,
            fossilCapacityMap,
            reliabilityData,
            reliabilityMap,
            selectedFuels: selectedFuels || [],
            selectedStatus: selectedStatus || 'existing'
        });

    } else if (viewMode === 'no-access') {
        const targetCf = state.targetCf || DEFAULT_LCOE_TARGET_CF;
        const lcoeResults = computeLcoeForAllLocations(targetCf / 100);
        const colorInfo = buildLcoeColorInfo(lcoeResults);

        if (targetCfSlider) {
            targetCfSlider.value = targetCf;
            if (targetCfDisplay) targetCfDisplay.textContent = targetCf;
        }

        // Update Slider UI Label
        const sliderLabel = document.querySelector('#target-cf-container .text-xs');
        if (sliderLabel) sliderLabel.innerHTML = 'Minimum cost to reach <span class="text-white font-medium">Uptime</span> of:';

        const metric = state.accessMetric || 'no_access_pop';
        setAccessMetric(metric);
        updatePopulationSimple(populationData, {
            baseLayer: 'access',
            overlayMode: state.overlayMode || 'none',
            lcoeData: [], // Clear LCOE data for the map dots
            reliabilityData,
            reliabilityMap,
            accessMetric: metric
        });

        showNoAccessLcoeChart(reliabilityData, locationIndex, lcoeParams, targetCf);

        if (targetCfContainer) targetCfContainer.classList.remove('hidden');
        if (inlineTargetCfContainer) inlineTargetCfContainer.classList.remove('hidden');

    } else if (viewMode === 'uptime-comparison') {
        const solar = state.solar || 6;
        const battery = state.battery || 20;
        const cfData = summaryData.filter(d => d.solar_gw === solar && d.batt_gwh === battery);

        updatePopulationSimple(populationData, {
            baseLayer: 'uptime',
            cfData,
            reliabilityData,
            reliabilityMap
        });

    } else if (viewMode === 'dual-globe') {
        // Step 4: Dual globe visualization
        hideDualGlobes(); // Reset first

        const targetCf = (state.targetCf || DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);

        // Render the dual globes
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        renderDualGlobes(populationData, lcoeResults, { lcoeColorInfo: colorInfo });
    }
}

// ========== ANIMATIONS ==========
function stopAnimations() {
    isAnimating = false;
    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }
    if (animationTimer) {
        clearTimeout(animationTimer);
        animationTimer = null;
    }
    if (animationIndicator) {
        animationIndicator.classList.add('hidden');
    }
}

function runAnimation(sectionId, state) {
    // Ensure clean slate
    stopAnimations();

    const animation = getAnimation(sectionId);
    if (!animation) return;

    isAnimating = true;

    if (animationIndicator) {
        animationIndicator.classList.remove('hidden');
    }

    const { type, from, to, duration, easing, loop, steps } = animation;

    if (type === 'battery-loop' && loop) {
        // Looping animation through discrete steps
        runLoopingAnimation(sectionId, state, steps || [0, 8, 16, 24], duration);
    } else if (type === 'battery-slider') {
        // One-shot animation from->to
        runOneShotAnimation(sectionId, state, from, to, duration, easing);
    }
}

function runLoopingAnimation(sectionId, state, steps, totalDuration) {
    let stepIndex = 0;
    const stepDuration = totalDuration / steps.length;

    function animateStep() {
        // Check if user has scrolled away
        if (currentSection !== sectionId) {
            isAnimating = false;
            if (animationIndicator) {
                animationIndicator.classList.add('hidden');
            }
            return;
        }

        const currentValue = steps[stepIndex];

        if (animationValue) {
            animationValue.textContent = currentValue;
        }
        if (batterySlider) {
            batterySlider.value = currentValue;
        }

        if (visualLabelSubtitle) {
            visualLabelSubtitle.textContent = `Cycling: ${currentValue} MWh`;
        }

        // Update map with current battery value AND current solar value from slider
        updateMap(summaryData, currentSolarState, currentValue, state.mapOptions || {});

        // Move to next step (loop back to 0)
        stepIndex = (stepIndex + 1) % steps.length;

        // Schedule next step
        animationTimer = setTimeout(animateStep, stepDuration);
    }

    animateStep();
}

function runOneShotAnimation(sectionId, state, from, to, duration, easing) {
    const startTime = performance.now();

    function animate(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        const currentValue = Math.round(interpolate(from, to, progress, easing));

        if (animationValue) {
            animationValue.textContent = currentValue;
        }
        if (batterySlider) {
            batterySlider.value = currentValue;
        }

        if (visualLabelSubtitle) {
            visualLabelSubtitle.textContent = `Battery: ${currentValue} MWh`;
        }

        updateMap(summaryData, state.solar || 5, currentValue, state.mapOptions || {});

        if (progress < 1) {
            animationFrame = requestAnimationFrame(animate);
        } else {
            isAnimating = false;
            if (animationIndicator) {
                animationIndicator.classList.add('hidden');
            }
            renderVisualState(state);
        }
    }

    animationFrame = requestAnimationFrame(animate);
}

// ========== SCROLL FADE LOGIC ==========
function handleScroll() {
    updateScrollOpacity();
}

function updateScrollOpacity() {
    // Find key sections
    // We want black at the boundaries (between sections)
    // And transparent in the middle of sections
    // Simple approach: Distance from center of screen to center of nearest section

    // Find active section element
    if (!currentSection) return;
    const sectionEl = document.querySelector(`[data-section="${currentSection}"]`);
    if (!sectionEl) return;

    const rect = sectionEl.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportCenter = viewportHeight / 2;
    const sectionCenter = rect.top + (rect.height / 2);

    // Distance from center (pixels)
    const dist = Math.abs(sectionCenter - viewportCenter);

    // Define "visible zone" where opacity is 0 (transparent map)
    // e.g. within 30% of viewport height from center
    const visibleZone = viewportHeight * 0.3;

    // And "fade zone" where it goes to 1 (black)
    // e.g. at 50% (screen edge)
    const fadeZone = viewportHeight * 0.5;

    let opacity = 0;

    if (dist < visibleZone) {
        opacity = 0;
    } else if (dist > fadeZone) {
        opacity = 1;
    } else {
        // Map linearly from 0 to 1
        opacity = (dist - visibleZone) / (fadeZone - visibleZone);
    }

    // Apply to overlay if controller has it
    if (transitionController.overlayA) {
        transitionController.overlayA.style.opacity = opacity;
    }
}

// ========== LCOE CALCULATIONS ==========
function computeLcoeForAllLocations(targetCf) {
    const results = [];
    const { solarCapex, batteryCapex, solarOpexPct, batteryOpexPct, solarLife, batteryLife, wacc } = lcoeParams;
    const globalSolarCapex = solarCapex * (lcoeOutlookMultipliers.solar || 1);
    const globalBatteryCapex = batteryCapex * (lcoeOutlookMultipliers.battery || 1);

    locationIndex.forEach((rows, locationId) => {
        let bestConfig = null;
        let minLcoe = Infinity;
        const localCapex = getLocalCapex(locationId);
        const localWacc = getLocalWacc(locationId);
        const effectiveSolarCapex = localCapex?.solar ?? globalSolarCapex;
        const effectiveBatteryCapex = localCapex?.battery ?? globalBatteryCapex;
        const effectiveWacc = localWacc ?? wacc;

        rows.forEach(row => {
            if (row.annual_cf >= targetCf && row.solar_gw <= 10) {
                const lcoe = computeLcoe(row, effectiveSolarCapex, effectiveBatteryCapex, effectiveWacc, solarLife, batteryLife, solarOpexPct, batteryOpexPct);
                if (lcoe < minLcoe) {
                    minLcoe = lcoe;
                    bestConfig = { ...row, lcoe, meetsTarget: true };
                }
            }
        });

        if (bestConfig) {
            results.push(bestConfig);
        } else {
            const maxCfRow = rows.reduce((a, b) => a.annual_cf > b.annual_cf ? a : b);
            const lcoe = computeLcoe(maxCfRow, effectiveSolarCapex, effectiveBatteryCapex, effectiveWacc, solarLife, batteryLife, solarOpexPct, batteryOpexPct);
            results.push({
                ...maxCfRow,
                lcoe,
                meetsTarget: false,
                maxConfigLcoe: lcoe,
                maxConfigSolar: maxCfRow.solar_gw,
                maxConfigBatt: maxCfRow.batt_gwh
            });
        }
    });

    return results;
}

function computeLcoe(row, solarCapex, batteryCapex, wacc, solarLife, batteryLife, solarOpexPct, batteryOpexPct) {
    const solarKw = row.solar_gw * 1000;
    const batteryKwh = row.batt_gwh * 1000;

    const solarCapexTotal = solarKw * solarCapex;
    const batteryCapexTotal = batteryKwh * batteryCapex;

    const solarCrf = crf(wacc, solarLife);
    const batteryCrf = crf(wacc, batteryLife);
    const annualSolarCost = solarCapexTotal * solarCrf + solarCapexTotal * solarOpexPct;
    const annualBatteryCost = batteryCapexTotal * batteryCrf + batteryCapexTotal * batteryOpexPct;

    const annualMwh = row.annual_cf * 8760;

    if (annualMwh <= 0) return Infinity;

    return (annualSolarCost + annualBatteryCost) / annualMwh;
}

function buildLcoeColorInfo(lcoeResults) {
    const validLcoe = lcoeResults.filter(r => r.meetsTarget && Number.isFinite(r.lcoe)).map(r => r.lcoe);
    if (validLcoe.length === 0) {
        return { type: 'lcoe', domain: [0, 25, 50, 75, 100, 200] };
    }

    return {
        type: 'lcoe',
        domain: [0, 25, 50, 75, 100, 200]
    };
}

// ========== START ==========
document.addEventListener('DOMContentLoaded', init);


// ========== WEEKLY MAP ANIMATION ==========
// ========== DATA UPDATES ==========
async function updateWeeklyData(solarMm, batteryMm, { silent = false, force = false } = {}) {
    const key = `${solarMm}_${batteryMm}`;
    if (!force && weeklySampleKey === key && weeklySampleData && weeklySampleData.length > 0) {
        return weeklySampleData;
    }
    if (!force && weeklySampleLoading && weeklySampleKey === key) {
        return weeklySampleLoading;
    }

    weeklySampleKey = key;
    const requestId = ++weeklySampleRequestId;

    const run = async () => {
        if (!silent) updateLoadingStatus('Loading sample data...');
        try {
            // Load sample data dynamic to slider
            const wrapper = await loadSampleColumnar(solarMm, batteryMm);
            const seasonData = wrapper.getRowsForSeason('summer');

            // Materialize coordinates from summaryData
            const coordMap = new Map();
            summaryData.forEach(d => coordMap.set(Number(d.location_id), { lat: d.latitude, lon: d.longitude }));

            seasonData.forEach(row => {
                const c = coordMap.get(Number(row.location_id));
                if (c) {
                    row.latitude = c.lat;
                    row.longitude = c.lon;
                }
            });

            if (requestId === weeklySampleRequestId) {
                weeklySampleData = seasonData;
            }
        } catch (e) {
            console.error("Failed to load sample data", e);
            if (requestId === weeklySampleRequestId) {
                weeklySampleData = null; // Reset on failure
            }
        } finally {
            if (!silent) updateLoadingStatus('');
            if (requestId === weeklySampleRequestId) {
                weeklySampleLoading = null;
            }
        }
    };

    weeklySampleLoading = run();
    return weeklySampleLoading;
}

// ========== ANIMATIONS ==========
function startWeeklyAnimation() {
    if (isAnimatingWeekly || weeklyAnimationInterval) return;
    if (!weeklySampleData || weeklySampleData.length === 0) return;

    isAnimatingWeekly = true;
    currentWeekFrame = 0;

    console.log("Starting weekly animation (500ms interval) with optimized rendering...");

    // OPTIMIZED: Initialize markers ONCE if not already done
    if (!isSampleFrameInitialized()) {
        // Force clear map layers first
        clearAllMapLayers();

        // Compute initial colors and initialize all markers
        const initialLocations = computeWeeklyFrameColors(0);
        initSampleFrameMap({
            timestamp: new Date().toISOString(),
            locations: initialLocations
        });
    }

    // Use a timer to update map every 500ms (matching main tool)
    // OPTIMIZED: Only updates colors, not DOM structure
    weeklyAnimationInterval = setInterval(() => {
        renderWeeklyFrameFast();
        // Assuming 168 hours in a week
        const len = weeklySampleData[0]?.timestamps?.length || 168;
        currentWeekFrame = (currentWeekFrame + 1) % len;
    }, 500);
}

function stopWeeklyAnimation() {
    if (weeklyAnimationInterval) {
        clearInterval(weeklyAnimationInterval);
        weeklyAnimationInterval = null;
    }
    isAnimatingWeekly = false;
    // Reset sample frame state when stopping animation (e.g., leaving Step 3)
    resetSampleFrameState();
}

/**
 * Compute colors for all locations at a given frame index.
 * Pure computation - no DOM manipulation.
 */
function computeWeeklyFrameColors(frameIndex) {
    if (!weeklySampleData || weeklySampleData.length === 0) return [];

    return weeklySampleData.map(loc => {
        const solarGenVector = loc.solar_gen;
        const battFlowVector = loc.battery_flow;

        // Helper to get value
        const getVal = (vector, idx) => {
            if (!vector) return 0;
            if (vector.get) return vector.get(idx); // Arrow Vector
            return vector[idx]; // Array
        };

        // Calculate local time index based on longitude
        const offset = Math.round(loc.longitude / 15);

        // Data length check
        const dataLen = solarGenVector.length || solarGenVector.toArray?.().length || 168;

        // Use modulo wrapping for localIndex to ensure continuous loop
        let localIndex = ((frameIndex + offset) % dataLen + dataLen) % dataLen;

        let solarGen = 0;
        let battFlow = 0;

        if (localIndex >= 0 && localIndex < dataLen) {
            solarGen = getVal(solarGenVector, localIndex) || 0;
            battFlow = getVal(battFlowVector, localIndex) || 0;
        }

        const discharge = battFlow > 0 ? battFlow : 0;

        // Calculate shares of 1.0 MW load
        let solarShare = Math.min(solarGen, 1.0);
        let batteryShare = Math.min(discharge, 1.0 - solarShare);
        let otherShare = Math.max(0, 1.0 - solarShare - batteryShare);

        // Colors
        // Yellow (Solar): #facc15 -> [250, 204, 21]
        // Purple (Battery): #a855f7 -> [168, 85, 247]
        // Gray (Other): #9ca3af -> [156, 163, 175]
        const r = Math.round(solarShare * 250 + batteryShare * 168 + otherShare * 156);
        const g = Math.round(solarShare * 204 + batteryShare * 85 + otherShare * 163);
        const b = Math.round(solarShare * 21 + batteryShare * 247 + otherShare * 175);

        return {
            location_id: loc.location_id,
            latitude: loc.latitude,
            longitude: loc.longitude,
            color: `rgb(${r}, ${g}, ${b})`,
            solarShare,
            batteryShare,
            otherShare
        };
    });
}

/**
 * OPTIMIZED: Fast render that only updates colors of existing markers.
 * No DOM element creation - just style updates.
 */
function renderWeeklyFrameFast() {
    if (!weeklySampleData || weeklySampleData.length === 0) return;

    const locations = computeWeeklyFrameColors(currentWeekFrame);

    // Use optimized color-only update
    updateSampleFrameColors(locations);
}

/**
 * LEGACY: Full render that recreates all DOM elements.
 * Kept for fallback or moveend handler.
 */
function renderWeeklyFrame() {
    if (!weeklySampleData || weeklySampleData.length === 0) return;

    const locations = computeWeeklyFrameColors(currentWeekFrame);

    updateMapWithSampleFrame({
        timestamp: new Date().toISOString(),
        locations: locations
    });
}
