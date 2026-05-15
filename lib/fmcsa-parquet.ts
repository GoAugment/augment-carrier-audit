/**
 * Parquet-backed FMCSA lookup. Reads from the bundled snapshot of FMCSA's
 * public bulk files (Census, Crashes, Inspections, Carrier authority,
 * Revocations, Enforcement) refreshed monthly.
 */
import path from "node:path";
import duckdb from "duckdb";

import type { FmcsaCarrier } from "./fmcsa";

const PARQUET_PATH = path.join(process.cwd(), "data", "carrier_aggregates.parquet");

let _db: duckdb.Database | null = null;

function db(): duckdb.Database {
  if (_db) return _db;
  _db = new duckdb.Database(":memory:");
  return _db;
}

function runQuery<T>(sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db().all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
}

interface ParquetRow {
  DOT_NUMBER: number | bigint;
  LEGAL_NAME: string | null;
  DBA_NAME: string | null;
  status_code: string | null;
  safety_rating: string | null;
  power_units: number | bigint | null;
  drivers: number | bigint | null;
  driver_inspections_24mo: number | bigint | null;
  driver_oos_24mo: number | bigint | null;
  vehicle_inspections_24mo: number | bigint | null;
  vehicle_oos_24mo: number | bigint | null;
  hazmat_inspections_24mo: number | bigint | null;
  hazmat_oos_24mo: number | bigint | null;
  crashes_24mo: number | bigint | null;
  fatal_crashes_24mo: number | bigint | null;
  injury_crashes_24mo: number | bigint | null;
  tow_crashes_24mo: number | bigint | null;
  bipd_insurance_required: string | null;
  bipd_insurance_on_file: number | null;
  bipd_required_amount: number | null;
  revocations_total: number | bigint | null;
  involuntary_revocations: number | bigint | null;
  most_recent_involuntary_date: string | null;
  enforcement_cases_count: number | bigint | null;
  enforcement_total_settled: number | bigint | null;
  enforcement_recent_date: string | null;
}

function asInt(v: number | bigint | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "bigint") return Number(v);
  return Math.floor(v);
}

function rowToCarrier(r: ParquetRow): FmcsaCarrier {
  const status = (r.status_code ?? "").toUpperCase();
  const allowedToOperate = status === "A" ? "Y" : status ? "N" : null;
  return {
    dotNumber: asInt(r.DOT_NUMBER),
    legalName: r.LEGAL_NAME,
    dbaName: r.DBA_NAME,
    allowedToOperate,
    statusCode: r.status_code,
    safetyRating: r.safety_rating,
    oosDate: null,
    totalDrivers: asInt(r.drivers),
    totalPowerUnits: asInt(r.power_units),
    driverInsp: asInt(r.driver_inspections_24mo),
    driverOosInsp: asInt(r.driver_oos_24mo),
    vehicleInsp: asInt(r.vehicle_inspections_24mo),
    vehicleOosInsp: asInt(r.vehicle_oos_24mo),
    hazmatInsp: asInt(r.hazmat_inspections_24mo),
    hazmatOosInsp: asInt(r.hazmat_oos_24mo),
    crashTotal: asInt(r.crashes_24mo),
    fatalCrash: asInt(r.fatal_crashes_24mo),
    injCrash: asInt(r.injury_crashes_24mo),
    towawayCrash: asInt(r.tow_crashes_24mo),
    bipdInsuranceRequired: r.bipd_insurance_required,
    bipdInsuranceOnFile: asInt(r.bipd_insurance_on_file),
    bipdRequiredAmount: asInt(r.bipd_required_amount),
    mcs150Mileage: 0,
    revocationsTotal: asInt(r.revocations_total),
    involuntaryRevocations: asInt(r.involuntary_revocations),
    mostRecentInvoluntaryDate: r.most_recent_involuntary_date,
    enforcementCasesCount: asInt(r.enforcement_cases_count),
    enforcementTotalSettled: asInt(r.enforcement_total_settled),
    enforcementRecentDate: r.enforcement_recent_date,
  };
}

export async function fetchCarriersFromParquet(
  dots: number[]
): Promise<Map<number, FmcsaCarrier>> {
  const unique = Array.from(new Set(dots));
  const out = new Map<number, FmcsaCarrier>();
  if (unique.length === 0) return out;

  const placeholders = unique.map(() => "?").join(",");
  const sql = `
    SELECT
      DOT_NUMBER, LEGAL_NAME, DBA_NAME, status_code, safety_rating,
      power_units, drivers,
      driver_inspections_24mo, driver_oos_24mo,
      vehicle_inspections_24mo, vehicle_oos_24mo,
      hazmat_inspections_24mo, hazmat_oos_24mo,
      crashes_24mo, fatal_crashes_24mo, injury_crashes_24mo, tow_crashes_24mo,
      bipd_insurance_required, bipd_insurance_on_file, bipd_required_amount,
      revocations_total, involuntary_revocations, most_recent_involuntary_date,
      enforcement_cases_count, enforcement_total_settled, enforcement_recent_date
    FROM read_parquet('${PARQUET_PATH.replace(/'/g, "''")}')
    WHERE DOT_NUMBER IN (${placeholders})
  `;

  const rows = await runQuery<ParquetRow>(sql, unique);
  for (const r of rows) {
    out.set(asInt(r.DOT_NUMBER), rowToCarrier(r));
  }
  return out;
}
