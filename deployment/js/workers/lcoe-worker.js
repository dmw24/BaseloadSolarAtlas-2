const STATE = {
    rowsByLocation: new Map()
};

function capitalRecoveryFactor(rate, years) {
    if (!Number.isFinite(rate) || !Number.isFinite(years) || years <= 0) {
        return 0;
    }
    if (rate === 0) {
        return 1 / years;
    }
    const numerator = rate * Math.pow(1 + rate, years);
    const denominator = Math.pow(1 + rate, years) - 1;
    return denominator === 0 ? 0 : numerator / denominator;
}

function getLocalCapex(localCapexByLocation, locationId) {
    if (!localCapexByLocation) return null;
    return localCapexByLocation[String(locationId)] || localCapexByLocation[locationId] || null;
}

function getLocalWacc(waccByLocation, locationId) {
    if (!waccByLocation) return null;
    const value = waccByLocation[String(locationId)] ?? waccByLocation[locationId];
    return Number.isFinite(value) ? value : null;
}

function computeConfigLcoe(row, params, costMultipliers, localWacc, localCapex) {
    const solarKw = Number.isFinite(row._solarKw) ? row._solarKw : row.solar_gw * 1_000_000;
    const batteryKwh = Number.isFinite(row._batteryKwh) ? row._batteryKwh : row.batt_gwh * 1_000_000;

    const ilr = Number.isFinite(params.ilr) && params.ilr > 0 ? params.ilr : 1;
    const solarCapexBase = Number.isFinite(localCapex?.solar)
        ? localCapex.solar
        : params.solarCapex * (costMultipliers?.solar || 1);
    const batteryCapexBase = Number.isFinite(localCapex?.battery)
        ? localCapex.battery
        : params.batteryCapex * (costMultipliers?.battery || 1);

    const solarCapexPerKw = solarCapexBase / ilr;
    const solarCapex = solarCapexPerKw * solarKw;
    const batteryCapex = batteryCapexBase * batteryKwh;

    const wacc = Number.isFinite(localWacc) ? localWacc : params.wacc;
    const solarAnnual = solarCapex * capitalRecoveryFactor(wacc, params.solarLife);
    const batteryAnnual = batteryCapex * capitalRecoveryFactor(wacc, params.batteryLife);
    const solarOpex = solarCapex * params.solarOpexPct;
    const batteryOpex = batteryCapex * params.batteryOpexPct;

    const annualCost = solarAnnual + batteryAnnual + solarOpex + batteryOpex;
    const annualEnergyMwh = Number.isFinite(row._annualEnergyMwh)
        ? row._annualEnergyMwh
        : row.annual_cf * 8760 * 1000;

    if (!Number.isFinite(annualEnergyMwh) || annualEnergyMwh <= 0) {
        return Infinity;
    }
    return annualCost / annualEnergyMwh;
}

function sortByLocationId(results) {
    results.sort((a, b) => {
        const aId = Number(a.location_id);
        const bId = Number(b.location_id);
        if (Number.isFinite(aId) && Number.isFinite(bId)) {
            return aId - bId;
        }
        return String(a.location_id).localeCompare(String(b.location_id));
    });
    return results;
}

function computeBestLcoe(payload) {
    const { targetCf, params, costMultipliers, waccByLocation, localCapexByLocation } = payload;
    const results = [];

    STATE.rowsByLocation.forEach((rows, locationId) => {
        const configPayloads = [];
        let bestMeeting = null;
        let bestFallback = null;
        let maxSolar = -Infinity;
        let maxBatt = -Infinity;

        const localWacc = getLocalWacc(waccByLocation, locationId);
        const localCapex = getLocalCapex(localCapexByLocation, locationId);

        rows.forEach((row) => {
            const lcoe = computeConfigLcoe(row, params, costMultipliers, localWacc, localCapex);
            const entry = { ...row, lcoe, targetCf };
            configPayloads.push(entry);

            if (row.annual_cf >= targetCf) {
                if (!bestMeeting || lcoe < bestMeeting.lcoe) {
                    bestMeeting = entry;
                }
            }

            if (!bestFallback || row.annual_cf > bestFallback.annual_cf) {
                bestFallback = entry;
            }

            if (row.solar_gw > maxSolar || (row.solar_gw === maxSolar && row.batt_gwh > maxBatt)) {
                maxSolar = row.solar_gw;
                maxBatt = row.batt_gwh;
            }
        });

        const highConfig = configPayloads.find((p) => p.solar_gw === maxSolar && p.batt_gwh === maxBatt)
            || configPayloads.reduce((best, p) => {
                if (!best) return p;
                if (p.solar_gw > best.solar_gw) return p;
                if (p.solar_gw === best.solar_gw && p.batt_gwh > best.batt_gwh) return p;
                return best;
            }, null);

        const chosen = bestMeeting
            ? { ...bestMeeting, meetsTarget: true }
            : bestFallback
                ? { ...bestFallback, meetsTarget: false }
                : null;

        if (chosen) {
            chosen.maxConfigSolar = highConfig?.solar_gw ?? null;
            chosen.maxConfigBatt = highConfig?.batt_gwh ?? null;
            chosen.maxConfigLcoe = highConfig?.lcoe ?? null;
            results.push(chosen);
        }
    });

    return sortByLocationId(results);
}

function computeCfAtTargetLcoe(payload) {
    const { targetLcoe, params, costMultipliers, waccByLocation, localCapexByLocation } = payload;
    const results = [];

    STATE.rowsByLocation.forEach((rows, locationId) => {
        let bestConfig = null;
        let bestFallback = null;

        const localWacc = getLocalWacc(waccByLocation, locationId);
        const localCapex = getLocalCapex(localCapexByLocation, locationId);

        rows.forEach((row) => {
            const lcoe = computeConfigLcoe(row, params, costMultipliers, localWacc, localCapex);
            const entry = { ...row, lcoe, cf: row.annual_cf, targetLcoe };

            if (lcoe <= targetLcoe) {
                if (!bestConfig) {
                    bestConfig = entry;
                } else if (entry.cf > bestConfig.cf) {
                    bestConfig = entry;
                } else if (entry.cf === bestConfig.cf && entry.lcoe < bestConfig.lcoe) {
                    bestConfig = entry;
                }
            }

            if (!bestFallback || lcoe < bestFallback.lcoe) {
                bestFallback = entry;
            }
        });

        if (bestConfig) {
            results.push({ ...bestConfig, meetsTarget: true });
        } else if (bestFallback) {
            results.push({ ...bestFallback, meetsTarget: false });
        }
    });

    return sortByLocationId(results);
}

function initData(rows) {
    const next = new Map();
    for (const row of rows || []) {
        const locationId = row.location_id;
        if (!next.has(locationId)) {
            next.set(locationId, []);
        }
        next.get(locationId).push(row);
    }
    STATE.rowsByLocation = next;
}

self.onmessage = (event) => {
    const { type, requestId, payload } = event.data || {};
    try {
        if (type === 'INIT_DATA') {
            initData(payload?.rows || []);
            self.postMessage({ type: 'RESULT', requestId, payload: { kind: 'INIT_DATA', ready: true } });
            return;
        }

        if (type === 'COMPUTE_BEST_LCOE') {
            const results = computeBestLcoe(payload || {});
            self.postMessage({ type: 'RESULT', requestId, payload: { kind: 'COMPUTE_BEST_LCOE', results } });
            return;
        }

        if (type === 'COMPUTE_CF_AT_TARGET_LCOE') {
            const results = computeCfAtTargetLcoe(payload || {});
            self.postMessage({ type: 'RESULT', requestId, payload: { kind: 'COMPUTE_CF_AT_TARGET_LCOE', results } });
            return;
        }

        self.postMessage({
            type: 'ERROR',
            requestId,
            payload: { message: `Unknown message type: ${type}` }
        });
    } catch (error) {
        self.postMessage({
            type: 'ERROR',
            requestId,
            payload: {
                message: error?.message || String(error),
                stack: error?.stack || null,
                kind: type || null
            }
        });
    }
};
