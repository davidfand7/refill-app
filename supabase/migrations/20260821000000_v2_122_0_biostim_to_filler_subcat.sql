-- v2.122.0 — Biostim moves from its own category to Filler + a "Biostim"
-- sub-category (Grasshopper's call: clinically it's a filler-family with a
-- sub-distinction, not a separate category). Re-file existing biostimulator
-- products + canonical brands → category 'filler', and tag the Biostim
-- sub-category (multi-select stored comma-joined in subcategory_area).

update public.products
  set category = 'filler',
      subcategory_area = case
        when subcategory_area is null or subcategory_area = '' then 'Biostim'
        when position('Biostim' in subcategory_area) > 0 then subcategory_area
        else subcategory_area || ', Biostim'
      end
  where category = 'biostimulator';

update public.canonical_brands
  set category = 'filler',
      subcategory_area = case
        when subcategory_area is null or subcategory_area = '' then 'Biostim'
        when position('Biostim' in subcategory_area) > 0 then subcategory_area
        else subcategory_area || ', Biostim'
      end
  where category = 'biostimulator';
