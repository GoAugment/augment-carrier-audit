// Sample input — a known mix that produces interesting results.
// (Real DOTs from publicly available FMCSA data.)
export const SAMPLE_INPUT = `# Sample carrier-load list. Format: DOT, optional load id, optional HAZMAT flag
# Try clicking "Audit now" to see the report against industry safety thresholds.
3621624, L-1001                 # DK MAX TRUCKING — known high crash rate
2075148, L-1002                 # ASAP TRANS CORP — known high crash rate
2049859, L-1003                 # XYQ EXPRESS — known high driver OOS
2049859, L-1004
2049859, L-1005
3201000, L-1006                 # LETEM TRANSPORTATION — high driver OOS
3168296, L-1007, HAZMAT         # AFS WORLD — hazmat load, elevated hazmat OOS
2902577, L-1008
3863705, L-1009
1221360, L-1010
3501896, L-1011, HAZMAT         # VOXSER — clean hazmat carrier (for contrast)
80806, L-1012                   # J.B. HUNT — clean large fleet
264184, L-1013                  # SCHNEIDER NATIONAL — clean large fleet
74432, L-1014                   # MARTEN TRANSPORT — clean large fleet
`;
