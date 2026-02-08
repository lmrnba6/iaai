/**
 * Browser-side filter helpers for IAA cars.
 * Prefer less to repair; exclude air bag and mechanical issues.
 */
(function (window) {
  const AIRBAG_KEYWORDS = /\b(air\s*bag|airbag|srs|deployed|supplemental\s*restraint)\b/i;
  const MECHANICAL_KEYWORDS = /\b(mechanical|engine\s*damage|transmission\s*damage|all\s*over|rollover|burn|burned|water|flood|electrical|drive\s*train|drivetrain|suspension|steering|frame|structural|undercarriage|rear\s*end|seized|no\s*start|won\'?t\s*start)\b/i;

  function parseDamageEstimate(s) {
    if (!s || typeof s !== 'string') return Infinity;
    const cleaned = String(s).replace(/[^\d.]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : Infinity;
  }

  function hasAirBagDamage(car) {
    const text = [car.damage, car.damageEstimate, car.condition].filter(Boolean).join(' ');
    return AIRBAG_KEYWORDS.test(text);
  }

  function hasMechanicalIssues(car) {
    const text = [car.damage, car.condition].filter(Boolean).join(' ');
    return MECHANICAL_KEYWORDS.test(text);
  }

  function isOttawa(car) {
    const text = [car.branch, car.location].filter(Boolean).join(' ');
    return /ottawa/i.test(text);
  }

  function isRunAndDrive(car) {
    const c = (car.condition || '').trim();
    return /run\s*and\s*drive|runanddrive/i.test(c);
  }

  function isOnNotBranded(car) {
    const b = (car.brand || '').trim();
    return /ON-NOT\s*BRANDED|ON\s*NOT\s*BRANDED/i.test(b);
  }

  /** Air Bags (from detail page) must be INTACT. Missing detail = pass. */
  function hasAirBagsIntact(car) {
    const v = (car.airBagsDetail || '').trim();
    if (!v) return true;
    return /^INTACT$/i.test(v);
  }

  /** Restraint System (from detail page) must not indicate major issues. Missing detail = pass. */
  const MAJOR_RESTRAINT_KEYWORDS = /\b(deployed|missing|not\s*present|not\s*intact|damaged|failed|malfunction|disconnected)\b/i;
  function hasNoMajorRestraintIssues(car) {
    const v = (car.restraintSystem || '').trim();
    if (!v) return true;
    return !MAJOR_RESTRAINT_KEYWORDS.test(v);
  }

  function parseAuctionDate(s) {
    if (!s || typeof s !== 'string') return Infinity;
    const trimmed = String(s).trim();
    if (!trimmed) return Infinity;
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? Infinity : d.getTime();
  }

  function filterAndSortCars(cars, options) {
    options = options || {};
    const excludeAirBags = options.excludeAirBags !== false;
    const excludeMechanical = options.excludeMechanical !== false;
    const sortByAuctionDate = options.sortByAuctionDate !== false;
    const sortByLessRepair = options.sortByLessRepair === true;
    const maxDamageEst = options.maxDamageEst;
    const onlyOttawa = options.onlyOttawa !== false;
    const onlyRunAndDrive = options.onlyRunAndDrive !== false;
    const onlyOnNotBranded = options.onlyOnNotBranded === true;
    const excludeAirBagsNotIntact = options.excludeAirBagsNotIntact !== false;
    const excludeMajorRestraintIssues = options.excludeMajorRestraintIssues !== false;

    let out = cars.slice();
    if (excludeAirBags) out = out.filter(function (c) { return !hasAirBagDamage(c); });
    if (excludeMechanical) out = out.filter(function (c) { return !hasMechanicalIssues(c); });
    if (onlyOttawa) out = out.filter(function (c) { return isOttawa(c); });
    if (onlyRunAndDrive) out = out.filter(function (c) { return isRunAndDrive(c); });
    if (onlyOnNotBranded) out = out.filter(function (c) { return isOnNotBranded(c); });
    if (excludeAirBagsNotIntact) out = out.filter(function (c) { return hasAirBagsIntact(c); });
    if (excludeMajorRestraintIssues) out = out.filter(function (c) { return hasNoMajorRestraintIssues(c); });
    if (maxDamageEst != null && Number.isFinite(maxDamageEst)) {
      out = out.filter(function (c) { return parseDamageEstimate(c.damageEstimate) <= maxDamageEst; });
    }
    if (sortByAuctionDate) {
      out.sort(function (a, b) {
        return parseAuctionDate(a.auctionDateTime) - parseAuctionDate(b.auctionDateTime);
      });
    } else if (sortByLessRepair) {
      out.sort(function (a, b) {
        return parseDamageEstimate(a.damageEstimate) - parseDamageEstimate(b.damageEstimate);
      });
    }
    return out;
  }

  window.IAAFilters = {
    parseDamageEstimate: parseDamageEstimate,
    parseAuctionDate: parseAuctionDate,
    hasAirBagDamage: hasAirBagDamage,
    hasMechanicalIssues: hasMechanicalIssues,
    isOttawa: isOttawa,
    isRunAndDrive: isRunAndDrive,
    isOnNotBranded: isOnNotBranded,
    hasAirBagsIntact: hasAirBagsIntact,
    hasNoMajorRestraintIssues: hasNoMajorRestraintIssues,
    filterAndSortCars: filterAndSortCars,
  };
})(window);
