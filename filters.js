/**
 * Filter and sort helpers for IAA cars.
 * Prefer less to repair; exclude air bag and mechanical issues.
 */

// Keywords that indicate air bag involvement (exclude these)
const AIRBAG_KEYWORDS = /\b(air\s*bag|airbag|srs|deployed|supplemental\s*restraint)\b/i;

// Keywords in damage description that indicate mechanical / structural issues (exclude these)
const MECHANICAL_KEYWORDS = /\b(mechanical|engine\s*damage|transmission\s*damage|all\s*over|rollover|burn|burned|water|flood|electrical|drive\s*train|drivetrain|suspension|steering|frame|structural|undercarriage|rear\s*end|front\s*end\s*damage|hit\s*in\s*engine|seized|no\s*start|won\'?t\s*start)\b/i;

/**
 * @param {string} s - e.g. "$7,183.00" or "£100"
 * @returns {number} numeric value or Infinity if unparseable
 */
function parseDamageEstimate(s) {
  if (!s || typeof s !== 'string') return Infinity;
  const cleaned = s.replace(/[^\d.]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : Infinity;
}

/**
 * @param {{ damage?: string, damageEstimate?: string, condition?: string }} car
 * @returns {boolean} true if damage/condition suggests air bag involvement
 */
function hasAirBagDamage(car) {
  const text = [car.damage, car.damageEstimate, car.condition].filter(Boolean).join(' ');
  return AIRBAG_KEYWORDS.test(text);
}

/**
 * @param {{ damage?: string, condition?: string }} car
 * @returns {boolean} true if damage suggests mechanical / heavy repair
 */
function hasMechanicalIssues(car) {
  const text = [car.damage, car.condition].filter(Boolean).join(' ');
  return MECHANICAL_KEYWORDS.test(text);
}

/** @param {{ branch?: string, location?: string }} car */
function isOttawa(car) {
  const text = [car.branch, car.location].filter(Boolean).join(' ');
  return /ottawa/i.test(text);
}

/** Ottawa, Toronto, Toronto North, Toronto West */
function isAllowedBranch(car) {
  const text = [car.branch, car.location].filter(Boolean).join(' ');
  return /ottawa|toronto/i.test(text);
}

/** True if car branch/location matches any of the location strings (case-insensitive contains). */
function carMatchesLocations(car, locations) {
  if (!Array.isArray(locations) || locations.length === 0) return true;
  const text = [car.branch, car.location].filter(Boolean).join(' ').toLowerCase();
  return locations.some((loc) => text.indexOf(String(loc).trim().toLowerCase()) !== -1);
}

/** @param {{ condition?: string }} car */
function isRunAndDrive(car) {
  const c = (car.condition || '').trim();
  return /run\s*and\s*drive|runanddrive/i.test(c);
}

/** @param {{ brand?: string }} car - allow ON-NOT BRANDED or QC-AUCUN STATUT */
function isOnNotBranded(car) {
  const b = (car.brand || '').trim();
  return /ON-NOT\s*BRANDED|ON\s*NOT\s*BRANDED|QC-AUCUN\s*STATUT/i.test(b);
}

/** Damage codes to exclude (Primary / Secd. / Other Damages from detail page). */
const SERIOUS_DAMAGE_CODES = ['EF', 'EB', 'IF', 'FM', 'ST', 'RO', 'TR', 'TB', 'VA', 'SU'];
const MODERATE_TO_SERIOUS_DAMAGE_CODES = ['EN', 'ID', 'UC', 'FW', 'HL'];
const FORBIDDEN_DAMAGE_CODES_REGEX = new RegExp(
  '\\b(' + [...SERIOUS_DAMAGE_CODES, ...MODERATE_TO_SERIOUS_DAMAGE_CODES].join('|') + ')\\b',
  'i'
);

/** True if Primary Damage, Secd. Damage, or Other Damages (from detail page) contains any forbidden code – exclude such cars. */
function hasForbiddenDamageCode(car) {
  const text = [car.primaryDamage, car.secdDamage, car.otherDamages].filter(Boolean).join(' ');
  if (!text.trim()) return false;
  return FORBIDDEN_DAMAGE_CODES_REGEX.test(text);
}

/** Air Bags (from detail page) must be INTACT. Missing detail = pass. Value may have extra whitespace/duplicate text from HTML. */
function hasAirBagsIntact(car) {
  const v = (car.airBagsDetail || '').replace(/\s+/g, ' ').trim();
  if (!v) return true;
  const firstWord = v.split(' ')[0] || '';
  return /^INTACT$/i.test(firstWord);
}

const MAJOR_RESTRAINT_KEYWORDS = /\b(deployed|missing|not\s*present|not\s*intact|damaged|failed|malfunction|disconnected)\b/i;

/** Restraint System (from detail page) must not indicate major issues. Missing detail = pass. */
function hasNoMajorRestraintIssues(car) {
  const v = (car.restraintSystem || '').trim();
  if (!v) return true;
  return !MAJOR_RESTRAINT_KEYWORDS.test(v);
}

/** Restraint System contains "airbag" / "air bag" – exclude such cars. */
function hasRestraintAirbag(car) {
  const v = (car.restraintSystem || '').trim().toLowerCase();
  return /airbag|air\s*bag/.test(v);
}

/** Restraint System contains any airbag-related issue (Bgs, Belts, air bag, ar bgs, SRS, deployed, etc.) – exclude such cars. */
const RESTRAINT_AIRBAG_OR_RELATED = /\b(air\s*bag|airbag|bgs|ar\s*bgs|belts|srs|deployed|supplemental\s*restraint)\b/i;

function hasRestraintAirbagOrRelated(car) {
  const v = (car.restraintSystem || '').trim();
  return RESTRAINT_AIRBAG_OR_RELATED.test(v);
}

/** Keys Present (from detail page) must be Yes. Missing = exclude. Value may have extra whitespace/duplicate text from HTML. */
function keysPresentYes(car) {
  const v = (car.keysPresent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const firstWord = v.split(' ')[0] || '';
  return firstWord === 'yes';
}

/**
 * @param {string} s - e.g. "Tue, Feb 10, 11:00 AM EST"
 * @returns {number} timestamp or Infinity if unparseable
 */
function parseAuctionDate(s) {
  if (!s || typeof s !== 'string') return Infinity;
  const trimmed = s.trim();
  if (!trimmed) return Infinity;
  const d = new Date(trimmed);
  return Number.isFinite(d.getTime()) ? d.getTime() : Infinity;
}

/**
 * Apply filters and optional sort by auction date or repair cost.
 * @param {Array<object>} cars
 * @param {{ excludeAirBags?: boolean, excludeMechanical?: boolean, excludeAirBagsNotIntact?: boolean, excludeMajorRestraintIssues?: boolean, sortByAuctionDate?: boolean, sortByLessRepair?: boolean, maxDamageEst?: number, onlyOttawa?: boolean, onlyRunAndDrive?: boolean, onlyOnNotBranded?: boolean }} options
 * @returns {Array<object>}
 */
function filterAndSortCars(cars, options = {}) {
  const {
    excludeAirBags = true,
    excludeMechanical = true,
    sortByAuctionDate = true,
    sortByLessRepair = false,
    maxDamageEst = null,
    onlyOttawa = true,
    onlyRunAndDrive = true,
    onlyOnNotBranded = false,
    excludeAirBagsNotIntact = true,
    excludeMajorRestraintIssues = true,
  } = options;

  let out = cars.slice();

  if (excludeAirBags) {
    out = out.filter((c) => !hasAirBagDamage(c));
  }
  if (excludeMechanical) {
    out = out.filter((c) => !hasMechanicalIssues(c));
  }
  if (onlyOttawa) {
    out = out.filter((c) => isOttawa(c));
  }
  if (onlyRunAndDrive) {
    out = out.filter((c) => isRunAndDrive(c));
  }
  if (onlyOnNotBranded) {
    out = out.filter((c) => isOnNotBranded(c));
  }
  if (excludeAirBagsNotIntact) {
    out = out.filter((c) => hasAirBagsIntact(c));
  }
  if (excludeMajorRestraintIssues) {
    out = out.filter((c) => hasNoMajorRestraintIssues(c));
  }
  if (maxDamageEst != null && Number.isFinite(maxDamageEst)) {
    out = out.filter((c) => parseDamageEstimate(c.damageEstimate) <= maxDamageEst);
  }
  if (sortByAuctionDate) {
    out.sort((a, b) => parseAuctionDate(a.auctionDateTime) - parseAuctionDate(b.auctionDateTime));
  } else if (sortByLessRepair) {
    out.sort((a, b) => parseDamageEstimate(a.damageEstimate) - parseDamageEstimate(b.damageEstimate));
  }

  return out;
}

module.exports = {
  parseDamageEstimate,
  parseAuctionDate,
  hasAirBagDamage,
  hasMechanicalIssues,
  isOttawa,
  isAllowedBranch,
  carMatchesLocations,
  isRunAndDrive,
  isOnNotBranded,
  hasForbiddenDamageCode,
  hasAirBagsIntact,
  hasNoMajorRestraintIssues,
  hasRestraintAirbag,
  hasRestraintAirbagOrRelated,
  keysPresentYes,
  filterAndSortCars,
  AIRBAG_KEYWORDS,
  MECHANICAL_KEYWORDS,
};
