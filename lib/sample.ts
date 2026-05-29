// Sample input — a curated mix where most carriers show ONE clear, specific
// pattern (more realistic than carriers that trip every rule), with a couple of
// multi-signal and clean carriers for contrast. Real DOTs from public FMCSA data.
export const SAMPLE_INPUT = `# Sample carrier-load list. Format: DOT, optional load id, optional HAZMAT flag
# Click "Audit now" to see each carrier scored against FMCSA safety data.
1388780, L-1001                 # FOX TRANSPORTATION — elevated crash rate only (~2.3/million mi), BASICs otherwise clean
1448431, L-1002                 # STANDARD LOGISTIC SERVICES — single Hours-of-Service alert, nothing else
2438425, L-1003                 # ALL PRO LOGISTICS — single Vehicle Maintenance alert (360-unit fleet)
2642590, L-1004                 # TEX-Q EXPRESS — one Driver Fitness acute/critical violation from an FMCSA investigation
2196912, L-1005                 # TEXAS INTERNATIONAL ENERGY — meets FMCSA High-Risk (HOS + Vehicle Maint ≥90th), not yet investigated
3610811, L-1006                 # MYKTYBEK EXPRESS — shared-fleet chameleon: 63% of its VINs run under another DOT
3293950, L-1007                 # LUMY MOVING — BIPD insurance cancels in ~15 days with no replacement on file
1162977, L-1008                 # UNIVERSAL INTERMODAL — fleet shed + very high per-mile crash rate (stale MCS-150 mileage)
3501896, L-1009, HAZMAT         # VOXSER — small hazmat carrier with 3 BASIC alerts (ISS is alert-pattern-driven, not size)
53467,   L-1010                 # WERNER — clean per-mile crash rate, but estimated ISS=Inspect via the hidden HM + Crash Indicator BASICs
80806,   L-1011                 # J.B. HUNT — clean large fleet (contrast)
74432,   L-1012                 # MARTEN TRANSPORT — clean large fleet (contrast)
`;
