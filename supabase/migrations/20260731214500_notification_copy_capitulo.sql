-- Glossary fix: a union chapter is a "capítulo", never a "sección".
--
-- Authority: the Bilingual design pass (design-source/design-passes/
-- Bilingual.dc.html, glossary row: chapter → capítulo, «Not "sección" — this
-- package used it three times and has been corrected»). The 20260728221544
-- notification copy sweep read that ruling backwards and seeded two Spanish
-- rows with the inverted word; this repoints them. App/API strings were fixed
-- in the same PR (src/lib/i18n.js, api/_lib/emailTemplate.js,
-- api/notifications-dispatch.js).

update private.notification_copy
   set body = 'Vota sobre las prioridades del presupuesto de acción del capítulo.'
 where key = 'seed.ballot' and lang = 'es';

update private.notification_copy
   set title = 'Nueva actualización del capítulo',
       body  = 'El último comunicado ficticio del capítulo está listo.'
 where key = 'seed.chapterUpdate' and lang = 'es';
