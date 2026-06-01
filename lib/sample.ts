// Sample input. The point of the demo: most of these carriers PASS the obvious
// checks — active authority, insurance on file — yet are high-risk on the
// non-obvious axes (safety outliers, FMCSA investigation findings, fraud
// signals). "$0 insurance" is the trivial case, so we show just ONE insurance-
// lapse example; the rest are "insured but high-risk." Real DOTs, public data.
export const SAMPLE_INPUT = `# Sample carrier-load list. Format: DOT, optional load id, optional HAZMAT flag
# Click "Audit now" to see each carrier scored against FMCSA safety data.
1388780, L-1001                 # FOX TRANSPORTATION — insured, but elevated crash rate (~2.3/million mi)
1448431, L-1002                 # STANDARD LOGISTIC SERVICES — fully insured, but FMCSA-rated Conditional + ISS Inspect
3501896, L-1003, HAZMAT         # VOXSER — insured hazmat carrier, 3 BASIC alerts (ISS 98 / Inspect)
1162977, L-1004                 # UNIVERSAL INTERMODAL — insured ($1M), but extreme per-mile crash rate + fleet shed
2244717, L-1005                 # QFS TRANSPORTATION — large 665-truck fleet, fully insured, yet meets FMCSA FAST-Act High-Risk
2642590, L-1006                 # TEX-Q EXPRESS — insured, but an acute/critical Driver Fitness violation from an FMCSA investigation
4436542, L-1007                 # NIMBUS 2000 — phantom fleet / rented authority: 207 trucks under a 1-power-unit DOT (Fraud High)
2524661, L-1008                 # STATE WIDE TRANS — the one insurance example: 189-truck freight carrier, BIPD cancels in ~11 days, no replacement filed
53467,   L-1009                 # WERNER — clean per-mile crash rate; estimated ISS=Inspect via the hidden HM + Crash Indicator BASICs
80806,   L-1010                 # J.B. HUNT — clean large fleet (contrast)
74432,   L-1011                 # MARTEN TRANSPORT — clean large fleet (contrast)
`;
