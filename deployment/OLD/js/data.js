import { readParquet } from './parquet_wasm.js';

// Initialize WASM
let wasmReady = false;

async function initWasm() {
    if (wasmReady) return;
    console.log("Initializing Parquet-Wasm...");
    const wasm = await import('./parquet_wasm.js');
    await wasm.default();
    wasmReady = true;
    console.log("Parquet-Wasm initialized.");
}

export async function loadSummary() {
    await initWasm();

    const response = await fetch('data/simulation_results_summary.parquet');
    const buffer = await response.arrayBuffer();
    try {
        const wasm = await import('./parquet_wasm.js');
        await wasm.default();
        const wasmTable = wasm.readParquet(new Uint8Array(buffer));
        const table = wasmTable.intoIPCStream();
        const { tableFromIPC } = await import('./apache-arrow.js');
        const arrowTable = tableFromIPC(table);
        const data = [];
        for (const row of arrowTable) {
            data.push(row.toJSON());
        }
        return data;
    } catch (e) {
        console.error("Error in loadSummary:", e);
        throw e;
    }
}

function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    const header = lines.shift();
    if (!header) return [];
    const cols = header.split(',');
    return lines.map(line => {
        const parts = line.split(',');
        const row = {};
        cols.forEach((c, idx) => {
            row[c] = parts[idx];
        });
        return row;
    });
}

export async function loadPopulationCsv() {
    const response = await fetch('data/voronoi_population_2020.csv');
    if (!response.ok) {
        throw new Error('Population CSV not found at data/voronoi_population_2020.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        population_2020: Number(row.population_2020)
    }));
}

export async function loadFossilPlantsCsv() {
    const response = await fetch('data/fossil_plants.csv');
    if (!response.ok) {
        throw new Error('Fossil plant CSV not found at data/fossil_plants.csv');
    }
    const rows = parseCsv(await response.text());
    return rows
        .map(row => ({
            plant_name: row.plant_name || '',
            country: row.country || '',
            fuel_group: (row.fuel_group || '').toLowerCase(),
            capacity_mw: Number(row.capacity_mw),
            latitude: Number(row.latitude),
            longitude: Number(row.longitude)
        }))
        .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}

export async function loadVoronoiFossilCapacityCsv() {
    const response = await fetch('data/voronoi_fossil_capacity.csv');
    if (!response.ok) {
        throw new Error('Voronoi fossil capacity CSV not found at data/voronoi_fossil_capacity.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        coal_mw: Number(row.coal_mw),
        gas_mw: Number(row.gas_mw),
        oil_mw: Number(row.oil_mw)
    }));
}

export async function loadVoronoiGeojson() {
    const response = await fetch('data/voronoi_cells.geojson');
    if (!response.ok) {
        throw new Error('Voronoi GeoJSON not found at data/voronoi_cells.geojson');
    }
    return response.json();
}

export async function loadSample(solarGw, battGwh) {
    await initWasm();

    const filename = `samples_s${solarGw}_b${battGwh}.parquet`;
    const response = await fetch(`data/samples/${filename}`);

    if (!response.ok) {
        throw new Error(`Sample file not found: ${filename}`);
    }

    const buffer = await response.arrayBuffer();
    const wasm = await import('./parquet_wasm.js');
    const { tableFromIPC } = await import('./apache-arrow.js');

    const wasmTable = wasm.readParquet(new Uint8Array(buffer));
    const table = wasmTable.intoIPCStream();
    const arrowTable = tableFromIPC(table);

    const data = [];
    for (const row of arrowTable) {
        data.push(row.toJSON());
    }

    return data;
}
