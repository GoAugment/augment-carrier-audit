/**
 * Identity layer — addresses, contacts, officers, cargo capabilities,
 * fleet composition, MCSIP status.
 *
 * Lives in a separate parquet (`data/carrier_identity.parquet`) from the
 * scoring data. The scoring hot path (lib/analyzer + lib/fmcsa-parquet)
 * never reads identity columns, so audits remain fast. Callers fetch
 * identity on demand — typically when a user drills into a specific
 * carrier ("inspect carrier" drawer) or when chameleon-cluster detection
 * needs to look for shared address / officer / phone across DOTs.
 *
 * Built by `augment-services/abuja/.context/fmcsa-aggregate/build_aggregates.py`
 * (see build_identity()). Refreshed monthly alongside the main parquet.
 */
import path from "node:path";
import duckdb from "duckdb";

const PARQUET_PATH = path.join(process.cwd(), "data", "carrier_identity.parquet");

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

/** Cargo capability flags FMCSA exposes per-carrier. Each is true when the
 *  carrier has indicated they handle that cargo class on their MCS-150. */
export interface CargoCapabilities {
  generalFreight: boolean;
  householdGoods: boolean;
  metalSheets: boolean;
  motorVehicles: boolean;
  driveAwayTowAway: boolean;
  logsPolesLumber: boolean;
  buildingMaterials: boolean;
  mobileHomes: boolean;
  machinery: boolean;
  produce: boolean;
  liquidsGases: boolean;
  intermodal: boolean;
  passengers: boolean;
  oilfield: boolean;
  livestock: boolean;
  grainFeedHay: boolean;
  coalCoke: boolean;
  meat: boolean;
  garbageRefuse: boolean;
  usMail: boolean;
  chemicals: boolean;
  dryBulk: boolean;
  refrigeratedFood: boolean;
  beverages: boolean;
  paperProducts: boolean;
  utilities: boolean;
  agriculturalFarm: boolean;
  construction: boolean;
  waterWell: boolean;
  other: boolean;
}

/** Owned + term-leased equipment counts. Heavy term-leasing relative to
 *  owned is a "thin operating company" pattern worth surfacing. */
export interface FleetComposition {
  ownedTrucks: number;
  ownedTractors: number;
  ownedTrailers: number;
  termLeasedTrucks: number;
  termLeasedTractors: number;
  termLeasedTrailers: number;
  avgDriversLeasedPerMonth: number;
}

/**
 * Coarse summary of a carrier's geographic reach. Derived from MCS-150's
 * four mileage radius flags (interstate/intrastate × within 100mi / beyond).
 */
export type OperatingArea =
  | "interstate_otr"      // long-haul interstate
  | "interstate_local"    // interstate within 100 miles
  | "intrastate_long"     // intrastate beyond 100 miles
  | "intrastate_local"    // intrastate within 100 miles
  | "unknown";

export interface CarrierIdentity {
  dotNumber: number;
  // Physical location (where trucks operate, not the legal mailing address)
  phyStreet: string | null;
  phyCity: string | null;
  phyState: string | null;
  phyZip: string | null;
  // Contact
  phone: string | null;
  /** Full email address (lowercased), or null when FMCSA didn't have one
   *  on file. ~1.58M of 2.08M carriers have it. */
  email: string | null;
  /** Email domain only (e.g. "gmail.com", "carriername.com"). Useful for
   *  cheap chameleon-clustering by domain. */
  emailDomain: string | null;
  // Corporate identity
  companyOfficer: string | null;     // primary officer (officer_1 in source)
  dunBradstreetNo: string | null;    // DUNS for credit/identity lookup
  // Operating area
  operatingArea: OperatingArea;
  interstateBeyond100mi: boolean;
  interstateWithin100mi: boolean;
  intrastateBeyond100mi: boolean;
  intrastateWithin100mi: boolean;
  // Fleet composition
  fleet: FleetComposition;
  // Cargo capabilities (30 boolean flags)
  cargo: CargoCapabilities;
  // Compliance status
  /** FMCSA Motor Carrier Safety Improvement Process step — letter code (A-G)
   *  indicating the formal stage of FMCSA's compliance-improvement track.
   *  Null means the carrier isn't currently in the process. */
  mcsipStep: string | null;
  mcsipDate: string | null;
  /** Census HM_Ind = 'Y'. Indicates the carrier carries hazmat materials per
   *  their MCS-150 self-report. Carriers without this flag should not be
   *  tendered placarded hazmat freight; doing so would put the broker on the
   *  hook if anything goes wrong. */
  hazmatFlag: boolean;
}

interface ParquetRow {
  DOT_NUMBER: number | bigint;
  phy_street: string | null;
  phy_city: string | null;
  phy_state: string | null;
  phy_zip: string | null;
  phone: string | null;
  email_address: string | null;
  email_domain: string | null;
  hazmat_flag: boolean | null;
  company_officer_1: string | null;
  dun_bradstreet_no: string | null;
  interstate_beyond_100mi: boolean | null;
  interstate_within_100mi: boolean | null;
  intrastate_beyond_100mi: boolean | null;
  intrastate_within_100mi: boolean | null;
  primary_operating_area: string | null;
  own_truck: number | bigint | null;
  own_tractor: number | bigint | null;
  own_trailer: number | bigint | null;
  term_leased_truck: number | bigint | null;
  term_leased_tractor: number | bigint | null;
  term_leased_trailer: number | bigint | null;
  avg_drivers_leased_per_month: number | bigint | null;
  mcsip_step: string | null;
  mcsip_date: string | null;
  cargo_general_freight: boolean | null;
  cargo_household_goods: boolean | null;
  cargo_metal_sheets: boolean | null;
  cargo_motor_vehicles: boolean | null;
  cargo_drive_away_tow_away: boolean | null;
  cargo_logs_poles_lumber: boolean | null;
  cargo_building_materials: boolean | null;
  cargo_mobile_homes: boolean | null;
  cargo_machinery: boolean | null;
  cargo_produce: boolean | null;
  cargo_liquids_gases: boolean | null;
  cargo_intermodal: boolean | null;
  cargo_passengers: boolean | null;
  cargo_oilfield: boolean | null;
  cargo_livestock: boolean | null;
  cargo_grain_feed_hay: boolean | null;
  cargo_coal_coke: boolean | null;
  cargo_meat: boolean | null;
  cargo_garbage_refuse: boolean | null;
  cargo_us_mail: boolean | null;
  cargo_chemicals: boolean | null;
  cargo_dry_bulk: boolean | null;
  cargo_refrigerated_food: boolean | null;
  cargo_beverages: boolean | null;
  cargo_paper_products: boolean | null;
  cargo_utilities: boolean | null;
  cargo_agricultural_farm: boolean | null;
  cargo_construction: boolean | null;
  cargo_water_well: boolean | null;
  cargo_other: boolean | null;
}

function asInt(v: number | bigint | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "bigint") return Number(v);
  return Math.floor(v);
}

function rowToIdentity(r: ParquetRow): CarrierIdentity {
  const area = (r.primary_operating_area ?? "unknown") as OperatingArea;
  return {
    dotNumber: asInt(r.DOT_NUMBER),
    phyStreet: r.phy_street,
    phyCity: r.phy_city,
    phyState: r.phy_state,
    phyZip: r.phy_zip,
    phone: r.phone,
    email: r.email_address,
    emailDomain: r.email_domain,
    companyOfficer: r.company_officer_1,
    dunBradstreetNo: r.dun_bradstreet_no,
    operatingArea: area,
    interstateBeyond100mi: r.interstate_beyond_100mi === true,
    interstateWithin100mi: r.interstate_within_100mi === true,
    intrastateBeyond100mi: r.intrastate_beyond_100mi === true,
    intrastateWithin100mi: r.intrastate_within_100mi === true,
    fleet: {
      ownedTrucks: asInt(r.own_truck),
      ownedTractors: asInt(r.own_tractor),
      ownedTrailers: asInt(r.own_trailer),
      termLeasedTrucks: asInt(r.term_leased_truck),
      termLeasedTractors: asInt(r.term_leased_tractor),
      termLeasedTrailers: asInt(r.term_leased_trailer),
      avgDriversLeasedPerMonth: asInt(r.avg_drivers_leased_per_month),
    },
    cargo: {
      generalFreight: r.cargo_general_freight === true,
      householdGoods: r.cargo_household_goods === true,
      metalSheets: r.cargo_metal_sheets === true,
      motorVehicles: r.cargo_motor_vehicles === true,
      driveAwayTowAway: r.cargo_drive_away_tow_away === true,
      logsPolesLumber: r.cargo_logs_poles_lumber === true,
      buildingMaterials: r.cargo_building_materials === true,
      mobileHomes: r.cargo_mobile_homes === true,
      machinery: r.cargo_machinery === true,
      produce: r.cargo_produce === true,
      liquidsGases: r.cargo_liquids_gases === true,
      intermodal: r.cargo_intermodal === true,
      passengers: r.cargo_passengers === true,
      oilfield: r.cargo_oilfield === true,
      livestock: r.cargo_livestock === true,
      grainFeedHay: r.cargo_grain_feed_hay === true,
      coalCoke: r.cargo_coal_coke === true,
      meat: r.cargo_meat === true,
      garbageRefuse: r.cargo_garbage_refuse === true,
      usMail: r.cargo_us_mail === true,
      chemicals: r.cargo_chemicals === true,
      dryBulk: r.cargo_dry_bulk === true,
      refrigeratedFood: r.cargo_refrigerated_food === true,
      beverages: r.cargo_beverages === true,
      paperProducts: r.cargo_paper_products === true,
      utilities: r.cargo_utilities === true,
      agriculturalFarm: r.cargo_agricultural_farm === true,
      construction: r.cargo_construction === true,
      waterWell: r.cargo_water_well === true,
      other: r.cargo_other === true,
    },
    mcsipStep: r.mcsip_step,
    mcsipDate: r.mcsip_date,
    hazmatFlag: r.hazmat_flag === true,
  };
}

/**
 * Look up identity for a batch of DOTs. Lazy — only call this when a UI
 * surface actually needs identity data; the audit scoring path doesn't.
 *
 * Returns a Map keyed by DOT_NUMBER for O(1) lookups. DOTs not in the
 * identity parquet (e.g. dormant carriers outside the audit universe)
 * are simply absent from the Map.
 */
export async function fetchIdentity(
  dots: number[]
): Promise<Map<number, CarrierIdentity>> {
  const unique = Array.from(new Set(dots));
  const out = new Map<number, CarrierIdentity>();
  if (unique.length === 0) return out;

  const placeholders = unique.map(() => "?").join(",");
  const sql = `
    SELECT *
    FROM read_parquet('${PARQUET_PATH.replace(/'/g, "''")}')
    WHERE DOT_NUMBER IN (${placeholders})
  `;
  const rows = await runQuery<ParquetRow>(sql, unique);
  for (const r of rows) {
    const identity = rowToIdentity(r);
    out.set(identity.dotNumber, identity);
  }
  return out;
}

/**
 * Find all carriers in the identity layer sharing a phone number. Used by
 * the email-check pipeline's chameleon-cluster evaluator to detect carriers
 * with shared contact identity (a strong but not definitive signal of
 * related-entity / re-incarnation patterns).
 *
 * Phone is normalized to digits-only before matching so "(800) 558-6767"
 * and "8005586767" both match. Returns identities for ALL DOTs with the
 * matching phone, including the queried carrier itself — caller is
 * responsible for excluding the focal DOT if they only want "others."
 */
export async function findIdentityByPhone(
  phone: string
): Promise<CarrierIdentity[]> {
  const normalized = phone.replace(/\D/g, "");
  if (normalized.length < 7) return []; // skip obvious junk

  // Match against parquet by normalizing both sides. The parquet stores
  // phone as whatever FMCSA records show (typically digits, sometimes with
  // dashes/parens). REGEXP_REPLACE strips non-digits on the parquet side.
  const sql = `
    SELECT *
    FROM read_parquet('${PARQUET_PATH.replace(/'/g, "''")}')
    WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = ?
  `;
  const rows = await runQuery<ParquetRow>(sql, [normalized]);
  return rows.map(rowToIdentity);
}

/**
 * Convenience helper: which cargo classes does this carrier handle? Returns
 * a list of human-readable labels for cargo capabilities that are true.
 * Useful for displaying "this carrier handles: refrigerated, hazmat, dry bulk"
 * without enumerating 30 boolean flags in the UI.
 */
export function cargoLabels(c: CargoCapabilities): string[] {
  const labels: Array<[boolean, string]> = [
    [c.generalFreight, "General Freight"],
    [c.householdGoods, "Household Goods"],
    [c.metalSheets, "Metal sheets/coils/rolls"],
    [c.motorVehicles, "Motor Vehicles"],
    [c.driveAwayTowAway, "Drive-away/Tow-away"],
    [c.logsPolesLumber, "Logs/Poles/Beams/Lumber"],
    [c.buildingMaterials, "Building Materials"],
    [c.mobileHomes, "Mobile Homes"],
    [c.machinery, "Machinery/Large Objects"],
    [c.produce, "Fresh Produce"],
    [c.liquidsGases, "Liquids/Gases"],
    [c.intermodal, "Intermodal Containers"],
    [c.passengers, "Passengers"],
    [c.oilfield, "Oilfield Equipment"],
    [c.livestock, "Livestock"],
    [c.grainFeedHay, "Grain/Feed/Hay"],
    [c.coalCoke, "Coal/Coke"],
    [c.meat, "Meat"],
    [c.garbageRefuse, "Garbage/Refuse"],
    [c.usMail, "US Mail"],
    [c.chemicals, "Chemicals"],
    [c.dryBulk, "Commodities Dry Bulk"],
    [c.refrigeratedFood, "Refrigerated Food"],
    [c.beverages, "Beverages"],
    [c.paperProducts, "Paper Products"],
    [c.utilities, "Utilities"],
    [c.agriculturalFarm, "Agricultural/Farm Supplies"],
    [c.construction, "Construction"],
    [c.waterWell, "Water/Well Drilling"],
    [c.other, "Other"],
  ];
  return labels.filter(([on]) => on).map(([, label]) => label);
}
