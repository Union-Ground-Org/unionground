-- REQ-UNION-BASE-BRAND-20260802
-- Preserve the stable reward key while replacing the retired product name in
-- the member-visible catalog. Existing clients continue to address the same
-- row; only the English and Spanish labels change.

update public.member_reward_items
set
  label_en = 'Union Base hoodie',
  label_es = 'Sudadera Union Base'
where key = 'sg-hoodie';
