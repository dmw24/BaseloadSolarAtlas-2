# Voronoi Solar Potential Methodology

Generated: 2026-01-27

## Inputs (global, free data)
- PVOUT raster (kWh/kWp/year): Global Solar Atlas GIS dataset (user-supplied file)
- GHSL built-up total (m^2): GHS-BUILT-S total built-up surface (user-supplied file)
- GHSL built-up NRES (m^2): GHS-BUILT-S non-residential allocation (user-supplied file)
- Landcover: ESA WorldCover (10 m) or other global landcover (user-supplied file)
- Slope source: SRTM DEM-derived slope (degrees) or equivalent slope raster

## Scenarios
### Conservative
- u_res = 0.15
- u_com = 0.25
- p_kw_m2 = 0.18
- d_roof = 0.85
- slope_max_deg = 5
- D_MW_km2 = 30
- d_util = 0.90

### High
- u_res = 0.30
- u_com = 0.50
- p_kw_m2 = 0.20
- d_roof = 0.90
- slope_max_deg = 10
- D_MW_km2 = 50
- d_util = 0.95

## Utility suitability exclusions
- Landcover excluded class codes: 50, 70, 80, 90, 95 (built-up, snow/ice, water, wetlands, mangroves)
- Excludes slopes above scenario slope_max_deg

## Key formulas
- B_res = max(B_total - B_nres, 0)
- kWp_res = B_res * u_res * p_kw_m2 * 1000
- kWp_com = B_nres * u_com * p_kw_m2 * 1000
- kWh_res = kWp_res * PVOUT * d_roof
- kWh_com = kWp_com * PVOUT * d_roof
- A_suit = S * A_pixel_m2
- kWp_util = A_suit * (D_MW_km2 * 0.001) * 1000
- kWh_util = kWp_util * PVOUT * d_util
- TWh = kWh / 1e9

## PVOUT coverage
- Pixels with missing PVOUT contribute 0 to kWh sums.
- pvout_coverage_frac = valid_pixels / total_pixels; zones with coverage < 0.80 are flagged.
- Global Solar Atlas PVOUT may be missing at high latitudes (~60N/55S); see coverage flags.

## Disclaimers
- Results are technical potential only (not economic/market potential).
- Outputs are planning-level and depend on input raster alignment/resampling.
