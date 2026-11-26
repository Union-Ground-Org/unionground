-- Keep the catalog keys and effect contracts stable while correcting English
-- names that described internal switches. Preserve any later admin wording.
begin;

set local lock_timeout = '5s';

update public.member_reward_items as item
set label_en = names.plain_label
from (values
  ('im-anyone', 'IM anyone bypass', 'Ask to contact another member directly'),
  ('wq-boost-2x', 'Weekly-question boost weight 2x', 'Count your support for weekly questions twice')
) as names(item_key, old_label, plain_label)
where item.key = names.item_key
  and item.label_en = names.old_label;

commit;
