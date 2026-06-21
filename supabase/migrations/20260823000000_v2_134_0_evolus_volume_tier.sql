-- v2.134.0 — Evolus: the third program shape (volume_tier) + master catalog.
--
-- WHY: Allergan's APP is a portfolio×brand-tier FORMULA; Galderma's ASPIRE is a
-- price TABLE. Evolus is a third shape entirely — a per-product VOLUME LADDER:
-- buy more cumulative units → unlock a lower price PER UNIT. No portfolio level,
-- no brand-family %, no rebate math. Each product carries its own ladder; the
-- spa just sits at a tier (1–6, INVERTED: tier 6 = lowest volume/highest price).
-- See reference_evolus_pricing (vision-captured from myevolus.evolus.com).
--
-- WHAT SHIPS:
--   • manufacturer_programs.evolus  stub → ACTIVE, program_type='volume_tier',
--     tiers jsonb carries productLadders keyed by brand_family (the ladder key).
--   • manufacturer_catalog          + Jeuveau (tox) and Evolysse (filler).
--
-- COST MODEL: the resolver (manufacturer-tier-resolver.ts, volume_tier branch)
-- reads productLadders[brand_family].tiers, finds the rung for the spa's selected
-- tier, and writes that absolute $/unit straight to cost_per_unit — NOT a % off
-- list. list_price (per box) = the tier-6 (1-unit) rack price; 1 box = 1 unit so
-- per-unit = list. No tier selected → cost = list (rack), cost_source 'unset'.
--
-- AREAS: Jeuveau is a tox (no area, like Botox). Evolysse's FDA area map wasn't
-- captured yet — left null until forwarded via vision (then it joins the
-- cross-manufacturer filler substitution groups). No GIGO guesses.
--
-- ROLLBACK:
--   delete from public.manufacturer_catalog where manufacturer='evolus';
--   update public.manufacturer_programs set status='stub',
--     program_type='loyalty', tiers='{}'::jsonb where manufacturer='evolus';

-- ─────────────────────────────────────────────────────────────────────────
-- Activate the Evolus program (volume_tier).
-- ─────────────────────────────────────────────────────────────────────────

update public.manufacturer_programs
set program_name = 'Evolus Rewards (volume tiers)',
    program_type = 'volume_tier',
    status       = 'active',
    tiers = '{
      "programType": "volume_tier",
      "note": "Inverted tiers: tier 6 = lowest volume/highest price; tier 1 = highest volume/lowest price. Thresholds = cumulative units.",
      "productLadders": {
        "Jeuveau": {
          "unitType": "vial",
          "tiers": [
            {"tier": 6, "minUnits": 1,   "price": 549},
            {"tier": 5, "minUnits": 20,  "price": 449},
            {"tier": 4, "minUnits": 50,  "price": 419},
            {"tier": 3, "minUnits": 100, "price": 399},
            {"tier": 2, "minUnits": 150, "price": 389},
            {"tier": 1, "minUnits": 250, "price": 379}
          ]
        },
        "Evolysse": {
          "unitType": "syringe",
          "tiers": [
            {"tier": 6, "minUnits": 1,   "price": 299},
            {"tier": 5, "minUnits": 10,  "price": 249},
            {"tier": 4, "minUnits": 20,  "price": 199},
            {"tier": 3, "minUnits": 50,  "price": 189},
            {"tier": 2, "minUnits": 100, "price": 179},
            {"tier": 1, "minUnits": 200, "price": 169}
          ]
        }
      }
    }'::jsonb,
    notes = 'Volume-tier ladder per product (reference_evolus_pricing). Tier = cumulative-units bracket; price is absolute $/unit at that bracket.'
where manufacturer = 'evolus';

-- ─────────────────────────────────────────────────────────────────────────
-- Seed Evolus master catalog. brand_family = the ladder key in productLadders.
-- list_price = per BOX = tier-6 rack price; units_per_box=1 (1 box = 1 unit).
-- ─────────────────────────────────────────────────────────────────────────

insert into public.manufacturer_catalog
  (manufacturer, brand_family, product_name, sku, category, unit_type, units_per_box, list_price, default_subcategory_area, status, sort_order, notes) values
  ('evolus', 'Jeuveau',  'Jeuveau 100 Units (1 vial)', 'JEU-100', 'tox',    'vial',    1, 549.00, null, 'active', 10, 'Volume-tier priced; cost resolves from selected tier (rack $549 → $379 at tier 1).'),
  ('evolus', 'Evolysse', 'Evolysse (HA filler, 1 syringe)', 'EVL-1', 'filler', 'syringe', 1, 299.00, null, 'active', 20, 'New Evolus HA filler line; FDA area map not yet captured (forward face-map via vision to enable cross-manufacturer substitution).')
on conflict (manufacturer, sku) do nothing;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────
-- Verify (paste after Run):
--   select manufacturer, status, program_type from public.manufacturer_programs where manufacturer='evolus';
--   -- expect: evolus | active | volume_tier
--   select product_name, brand_family, category, list_price from public.manufacturer_catalog where manufacturer='evolus' order by sort_order;
--   -- expect: Jeuveau (Jeuveau/tox/549.00), Evolysse (Evolysse/filler/299.00)
-- ─────────────────────────────────────────────────────────────────────────
