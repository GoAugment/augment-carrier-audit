# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb>=1.0"]
# ///
"""Build an empirical insurer-reputation lookup: each BIPD insurer's portfolio
involuntary-revocation rate vs the national base. "Specialty"/RRG (surplus-lines)
insurers write the carriers standard insurers won't, and their books revoke 3-5x
more — a leading signal known at booking time. Output → lib/data/insurer-risk.json
(keyed by upper-cased insurer name) for the analyzer's Fraud score + issue list.

Regenerate on each refresh. Tiers: high (lift>=2.5), elevated (lift>=1.5),
among insurers with >=500 carriers; everyone else is omitted (treated normal).
"""
import json, os
from pathlib import Path
import duckdb

REFRESH = os.environ.get("FMCSA_REFRESH_DIR", "data/sources/refresh_20260529")
A = os.environ.get("FMCSA_ACTPEND", f"{REFRESH}/ActPendInsur_All_With_History.csv")
R = os.environ.get("FMCSA_REVOCATION", "/__unset__run-via-build_all.py-or-set-the-env-var__/Revocation_-_All_With_History_20260514.csv")
OUT = Path(os.environ.get("FMCSA_INSURER_RISK_OUT", "lib/data/insurer-risk.json"))
OW0, OW1 = "2025-04-01", "2026-04-30"

con = duckdb.connect(); con.execute("PRAGMA threads=4")
con.execute(f"""create temp table owrev as select distinct DOT_NUMBER dot from read_csv_auto('{R}',ignore_errors=true)
  where ORDER2_TYPE_DESC='INVOLUNTARY REVOCATION' and try_cast(order2_effective_Date as date) between date '{OW0}' and date '{OW1}'""")
con.execute(f"""create temp table ins as select DOT_NUMBER dot,
  upper(trim(arg_max(name_company, try_cast(effective_date as date)))) insurer
  from read_csv_auto('{A}',ignore_errors=true) where ins_type_desc ilike 'BIPD%'
   and try_cast(effective_date as date) is not null group by 1""")
con.execute("create temp table base as select i.insurer, (o.dot is not null)::int y from ins i left join owrev o using(dot) where i.insurer is not null")
b = con.execute("select avg(y) from base").fetchone()[0]
rows = con.execute("select insurer, count(*) n, avg(y) rev from base group by 1 having count(*)>=500").fetchall()
out = {}
for insurer, n, rev in rows:
    lift = rev / b if b else 0
    tier = "high" if lift >= 2.5 else "elevated" if lift >= 1.5 else None
    if tier:
        out[insurer] = {"tier": tier, "lift": round(lift, 1), "rate": round(rev, 4), "n": int(n)}
OUT.write_text(json.dumps({"base_rate": round(b, 4), "insurers": out}, indent=0))
print(f"[build_insurer_risk] base={b:.2%}  flagged insurers: {len(out)} (high={sum(1 for v in out.values() if v['tier']=='high')}) -> {OUT}")
