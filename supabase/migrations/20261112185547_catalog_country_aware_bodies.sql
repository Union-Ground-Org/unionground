begin;
do $predecessors$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc as p where p.oid = pg_catalog.to_regprocedure('public.search_union_catalog(text,text,text,text,integer)')) is distinct from '40cda305c1b4d336f36118a2722c3f35' then
    raise exception 'catalog locale predecessor changed: public.search_union_catalog';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc as p where p.oid = pg_catalog.to_regprocedure('public.get_union_catalog_profile(text)')) is distinct from 'd9fc98bbf11725f8467ed7673b90898f' then
    raise exception 'catalog locale predecessor changed: public.get_union_catalog_profile';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc as p where p.oid = pg_catalog.to_regprocedure('private.catalog_activate_release(text)')) is distinct from '5813439ed15f8908b9dae9fc1aa2b936' then
    raise exception 'catalog locale predecessor changed: private.catalog_activate_release';
  end if;
end;
$predecessors$;
-- REQ-UG-CATALOG-COUNTRY-AWARE-BODIES-OUTSIDE-US-20261112.
-- Schema only. No catalog or tenant data is imported by this migration.
-- ISO membership is pinned to the same iso-codes snapshot as the JS gate.
create function private.catalog_country_valid(p_value text)
returns boolean language sql immutable set search_path = '' as $function$
  select p_value = any(array['AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI','VN','VU','WF','WS','YE','YT','ZA','ZM','ZW']::text[]);
$function$;
revoke all on function private.catalog_country_valid(text) from public, anon, authenticated, service_role;
create function private.catalog_subdivision_valid(p_value text)
returns boolean language sql immutable set search_path = '' as $function$
  select p_value = any(array['AD-02','AD-03','AD-04','AD-05','AD-06','AD-07','AD-08','AE-AJ','AE-AZ','AE-DU','AE-FU','AE-RK','AE-SH','AE-UQ','AF-BAL','AF-BAM','AF-BDG','AF-BDS','AF-BGL','AF-DAY','AF-FRA','AF-FYB','AF-GHA','AF-GHO','AF-HEL','AF-HER','AF-JOW','AF-KAB','AF-KAN','AF-KAP','AF-KDZ','AF-KHO','AF-KNR','AF-LAG','AF-LOG','AF-NAN','AF-NIM','AF-NUR','AF-PAN','AF-PAR','AF-PIA','AF-PKA','AF-SAM','AF-SAR','AF-TAK','AF-URU','AF-WAR','AF-ZAB','AG-03','AG-04','AG-05','AG-06','AG-07','AG-08','AG-10','AG-11','AL-01','AL-02','AL-03','AL-04','AL-05','AL-06','AL-07','AL-08','AL-09','AL-10','AL-11','AL-12','AM-AG','AM-AR','AM-AV','AM-ER','AM-GR','AM-KT','AM-LO','AM-SH','AM-SU','AM-TV','AM-VD','AO-BGO','AO-BGU','AO-BIE','AO-CAB','AO-CCU','AO-CNN','AO-CNO','AO-CUS','AO-HUA','AO-HUI','AO-LNO','AO-LSU','AO-LUA','AO-MAL','AO-MOX','AO-NAM','AO-UIG','AO-ZAI','AR-A','AR-B','AR-C','AR-D','AR-E','AR-F','AR-G','AR-H','AR-J','AR-K','AR-L','AR-M','AR-N','AR-P','AR-Q','AR-R','AR-S','AR-T','AR-U','AR-V','AR-W','AR-X','AR-Y','AR-Z','AT-1','AT-2','AT-3','AT-4','AT-5','AT-6','AT-7','AT-8','AT-9','AU-ACT','AU-NSW','AU-NT','AU-QLD','AU-SA','AU-TAS','AU-VIC','AU-WA','AZ-ABS','AZ-AGA','AZ-AGC','AZ-AGM','AZ-AGS','AZ-AGU','AZ-AST','AZ-BA','AZ-BAB','AZ-BAL','AZ-BAR','AZ-BEY','AZ-BIL','AZ-CAB','AZ-CAL','AZ-CUL','AZ-DAS','AZ-FUZ','AZ-GA','AZ-GAD','AZ-GOR','AZ-GOY','AZ-GYG','AZ-HAC','AZ-IMI','AZ-ISM','AZ-KAL','AZ-KAN','AZ-KUR','AZ-LA','AZ-LAC','AZ-LAN','AZ-LER','AZ-MAS','AZ-MI','AZ-NA','AZ-NEF','AZ-NV','AZ-NX','AZ-OGU','AZ-ORD','AZ-QAB','AZ-QAX','AZ-QAZ','AZ-QBA','AZ-QBI','AZ-QOB','AZ-QUS','AZ-SA','AZ-SAB','AZ-SAD','AZ-SAH','AZ-SAK','AZ-SAL','AZ-SAR','AZ-SAT','AZ-SBN','AZ-SIY','AZ-SKR','AZ-SM','AZ-SMI','AZ-SMX','AZ-SR','AZ-SUS','AZ-TAR','AZ-TOV','AZ-UCA','AZ-XA','AZ-XAC','AZ-XCI','AZ-XIZ','AZ-XVD','AZ-YAR','AZ-YE','AZ-YEV','AZ-ZAN','AZ-ZAQ','AZ-ZAR','BA-BIH','BA-BRC','BA-SRP','BB-01','BB-02','BB-03','BB-04','BB-05','BB-06','BB-07','BB-08','BB-09','BB-10','BB-11','BD-01','BD-02','BD-03','BD-04','BD-05','BD-06','BD-07','BD-08','BD-09','BD-10','BD-11','BD-12','BD-13','BD-14','BD-15','BD-16','BD-17','BD-18','BD-19','BD-20','BD-21','BD-22','BD-23','BD-24','BD-25','BD-26','BD-27','BD-28','BD-29','BD-30','BD-31','BD-32','BD-33','BD-34','BD-35','BD-36','BD-37','BD-38','BD-39','BD-40','BD-41','BD-42','BD-43','BD-44','BD-45','BD-46','BD-47','BD-48','BD-49','BD-50','BD-51','BD-52','BD-53','BD-54','BD-55','BD-56','BD-57','BD-58','BD-59','BD-60','BD-61','BD-62','BD-63','BD-64','BD-A','BD-B','BD-C','BD-D','BD-E','BD-F','BD-G','BD-H','BE-BRU','BE-VAN','BE-VBR','BE-VLG','BE-VLI','BE-VOV','BE-VWV','BE-WAL','BE-WBR','BE-WHT','BE-WLG','BE-WLX','BE-WNA','BF-01','BF-02','BF-03','BF-04','BF-05','BF-06','BF-07','BF-08','BF-09','BF-10','BF-11','BF-12','BF-13','BF-BAL','BF-BAM','BF-BAN','BF-BAZ','BF-BGR','BF-BLG','BF-BLK','BF-COM','BF-GAN','BF-GNA','BF-GOU','BF-HOU','BF-IOB','BF-KAD','BF-KEN','BF-KMD','BF-KMP','BF-KOP','BF-KOS','BF-KOT','BF-KOW','BF-LER','BF-LOR','BF-MOU','BF-NAM','BF-NAO','BF-NAY','BF-NOU','BF-OUB','BF-OUD','BF-PAS','BF-PON','BF-SEN','BF-SIS','BF-SMT','BF-SNG','BF-SOM','BF-SOR','BF-TAP','BF-TUI','BF-YAG','BF-YAT','BF-ZIR','BF-ZON','BF-ZOU','BG-01','BG-02','BG-03','BG-04','BG-05','BG-06','BG-07','BG-08','BG-09','BG-10','BG-11','BG-12','BG-13','BG-14','BG-15','BG-16','BG-17','BG-18','BG-19','BG-20','BG-21','BG-22','BG-23','BG-24','BG-25','BG-26','BG-27','BG-28','BH-13','BH-14','BH-15','BH-17','BI-BB','BI-BL','BI-BM','BI-BR','BI-CA','BI-CI','BI-GI','BI-KI','BI-KR','BI-KY','BI-MA','BI-MU','BI-MW','BI-MY','BI-NG','BI-RM','BI-RT','BI-RY','BJ-AK','BJ-AL','BJ-AQ','BJ-BO','BJ-CO','BJ-DO','BJ-KO','BJ-LI','BJ-MO','BJ-OU','BJ-PL','BJ-ZO','BN-BE','BN-BM','BN-TE','BN-TU','BO-B','BO-C','BO-H','BO-L','BO-N','BO-O','BO-P','BO-S','BO-T','BQ-BO','BQ-SA','BQ-SE','BR-AC','BR-AL','BR-AM','BR-AP','BR-BA','BR-CE','BR-DF','BR-ES','BR-GO','BR-MA','BR-MG','BR-MS','BR-MT','BR-PA','BR-PB','BR-PE','BR-PI','BR-PR','BR-RJ','BR-RN','BR-RO','BR-RR','BR-RS','BR-SC','BR-SE','BR-SP','BR-TO','BS-AK','BS-BI','BS-BP','BS-BY','BS-CE','BS-CI','BS-CK','BS-CO','BS-CS','BS-EG','BS-EX','BS-FP','BS-GC','BS-HI','BS-HT','BS-IN','BS-LI','BS-MC','BS-MG','BS-MI','BS-NE','BS-NO','BS-NP','BS-NS','BS-RC','BS-RI','BS-SA','BS-SE','BS-SO','BS-SS','BS-SW','BS-WG','BT-11','BT-12','BT-13','BT-14','BT-15','BT-21','BT-22','BT-23','BT-24','BT-31','BT-32','BT-33','BT-34','BT-41','BT-42','BT-43','BT-44','BT-45','BT-GA','BT-TY','BW-CE','BW-CH','BW-FR','BW-GA','BW-GH','BW-JW','BW-KG','BW-KL','BW-KW','BW-LO','BW-NE','BW-NW','BW-SE','BW-SO','BW-SP','BW-ST','BY-BR','BY-HM','BY-HO','BY-HR','BY-MA','BY-MI','BY-VI','BZ-BZ','BZ-CY','BZ-CZL','BZ-OW','BZ-SC','BZ-TOL','CA-AB','CA-BC','CA-MB','CA-NB','CA-NL','CA-NS','CA-NT','CA-NU','CA-ON','CA-PE','CA-QC','CA-SK','CA-YT','CD-BC','CD-BU','CD-EQ','CD-HK','CD-HL','CD-HU','CD-IT','CD-KC','CD-KE','CD-KG','CD-KL','CD-KN','CD-KS','CD-LO','CD-LU','CD-MA','CD-MN','CD-MO','CD-NK','CD-NU','CD-SA','CD-SK','CD-SU','CD-TA','CD-TO','CD-TU','CF-AC','CF-BB','CF-BGF','CF-BK','CF-HK','CF-HM','CF-HS','CF-KB','CF-KG','CF-LB','CF-MB','CF-MP','CF-NM','CF-OP','CF-SE','CF-UK','CF-VK','CG-11','CG-12','CG-13','CG-14','CG-15','CG-16','CG-2','CG-5','CG-7','CG-8','CG-9','CG-BZV','CH-AG','CH-AI','CH-AR','CH-BE','CH-BL','CH-BS','CH-FR','CH-GE','CH-GL','CH-GR','CH-JU','CH-LU','CH-NE','CH-NW','CH-OW','CH-SG','CH-SH','CH-SO','CH-SZ','CH-TG','CH-TI','CH-UR','CH-VD','CH-VS','CH-ZG','CH-ZH','CI-AB','CI-BS','CI-CM','CI-DN','CI-GD','CI-LC','CI-LG','CI-MG','CI-SM','CI-SV','CI-VB','CI-WR','CI-YM','CI-ZZ','CL-AI','CL-AN','CL-AP','CL-AR','CL-AT','CL-BI','CL-CO','CL-LI','CL-LL','CL-LR','CL-MA','CL-ML','CL-NB','CL-RM','CL-TA','CL-VS','CM-AD','CM-CE','CM-EN','CM-ES','CM-LT','CM-NO','CM-NW','CM-OU','CM-SU','CM-SW','CN-AH','CN-BJ','CN-CQ','CN-FJ','CN-GD','CN-GS','CN-GX','CN-GZ','CN-HA','CN-HB','CN-HE','CN-HI','CN-HK','CN-HL','CN-HN','CN-JL','CN-JS','CN-JX','CN-LN','CN-MO','CN-NM','CN-NX','CN-QH','CN-SC','CN-SD','CN-SH','CN-SN','CN-SX','CN-TJ','CN-TW','CN-XJ','CN-XZ','CN-YN','CN-ZJ','CO-AMA','CO-ANT','CO-ARA','CO-ATL','CO-BOL','CO-BOY','CO-CAL','CO-CAQ','CO-CAS','CO-CAU','CO-CES','CO-CHO','CO-COR','CO-CUN','CO-DC','CO-GUA','CO-GUV','CO-HUI','CO-LAG','CO-MAG','CO-MET','CO-NAR','CO-NSA','CO-PUT','CO-QUI','CO-RIS','CO-SAN','CO-SAP','CO-SUC','CO-TOL','CO-VAC','CO-VAU','CO-VID','CR-A','CR-C','CR-G','CR-H','CR-L','CR-P','CR-SJ','CU-01','CU-03','CU-04','CU-05','CU-06','CU-07','CU-08','CU-09','CU-10','CU-11','CU-12','CU-13','CU-14','CU-15','CU-16','CU-99','CV-B','CV-BR','CV-BV','CV-CA','CV-CF','CV-CR','CV-MA','CV-MO','CV-PA','CV-PN','CV-PR','CV-RB','CV-RG','CV-RS','CV-S','CV-SD','CV-SF','CV-SL','CV-SM','CV-SO','CV-SS','CV-SV','CV-TA','CV-TS','CY-01','CY-02','CY-03','CY-04','CY-05','CY-06','CZ-10','CZ-20','CZ-201','CZ-202','CZ-203','CZ-204','CZ-205','CZ-206','CZ-207','CZ-208','CZ-209','CZ-20A','CZ-20B','CZ-20C','CZ-31','CZ-311','CZ-312','CZ-313','CZ-314','CZ-315','CZ-316','CZ-317','CZ-32','CZ-321','CZ-322','CZ-323','CZ-324','CZ-325','CZ-326','CZ-327','CZ-41','CZ-411','CZ-412','CZ-413','CZ-42','CZ-421','CZ-422','CZ-423','CZ-424','CZ-425','CZ-426','CZ-427','CZ-51','CZ-511','CZ-512','CZ-513','CZ-514','CZ-52','CZ-521','CZ-522','CZ-523','CZ-524','CZ-525','CZ-53','CZ-531','CZ-532','CZ-533','CZ-534','CZ-63','CZ-631','CZ-632','CZ-633','CZ-634','CZ-635','CZ-64','CZ-641','CZ-642','CZ-643','CZ-644','CZ-645','CZ-646','CZ-647','CZ-71','CZ-711','CZ-712','CZ-713','CZ-714','CZ-715','CZ-72','CZ-721','CZ-722','CZ-723','CZ-724','CZ-80','CZ-801','CZ-802','CZ-803','CZ-804','CZ-805','CZ-806','DE-BB','DE-BE','DE-BW','DE-BY','DE-HB','DE-HE','DE-HH','DE-MV','DE-NI','DE-NW','DE-RP','DE-SH','DE-SL','DE-SN','DE-ST','DE-TH','DJ-AR','DJ-AS','DJ-DI','DJ-DJ','DJ-OB','DJ-TA','DK-81','DK-82','DK-83','DK-84','DK-85','DM-02','DM-03','DM-04','DM-05','DM-06','DM-07','DM-08','DM-09','DM-10','DM-11','DO-01','DO-02','DO-03','DO-04','DO-05','DO-06','DO-07','DO-08','DO-09','DO-10','DO-11','DO-12','DO-13','DO-14','DO-15','DO-16','DO-17','DO-18','DO-19','DO-20','DO-21','DO-22','DO-23','DO-24','DO-25','DO-26','DO-27','DO-28','DO-29','DO-30','DO-31','DO-32','DO-33','DO-34','DO-35','DO-36','DO-37','DO-38','DO-39','DO-40','DO-41','DO-42','DZ-01','DZ-02','DZ-03','DZ-04','DZ-05','DZ-06','DZ-07','DZ-08','DZ-09','DZ-10','DZ-11','DZ-12','DZ-13','DZ-14','DZ-15','DZ-16','DZ-17','DZ-18','DZ-19','DZ-20','DZ-21','DZ-22','DZ-23','DZ-24','DZ-25','DZ-26','DZ-27','DZ-28','DZ-29','DZ-30','DZ-31','DZ-32','DZ-33','DZ-34','DZ-35','DZ-36','DZ-37','DZ-38','DZ-39','DZ-40','DZ-41','DZ-42','DZ-43','DZ-44','DZ-45','DZ-46','DZ-47','DZ-48','DZ-49','DZ-50','DZ-51','DZ-52','DZ-53','DZ-54','DZ-55','DZ-56','DZ-57','DZ-58','EC-A','EC-B','EC-C','EC-D','EC-E','EC-F','EC-G','EC-H','EC-I','EC-L','EC-M','EC-N','EC-O','EC-P','EC-R','EC-S','EC-SD','EC-SE','EC-T','EC-U','EC-W','EC-X','EC-Y','EC-Z','EE-130','EE-141','EE-142','EE-171','EE-184','EE-191','EE-198','EE-205','EE-214','EE-245','EE-247','EE-251','EE-255','EE-272','EE-283','EE-284','EE-291','EE-293','EE-296','EE-303','EE-305','EE-317','EE-321','EE-338','EE-353','EE-37','EE-39','EE-424','EE-430','EE-431','EE-432','EE-441','EE-442','EE-446','EE-45','EE-478','EE-480','EE-486','EE-50','EE-503','EE-511','EE-514','EE-52','EE-528','EE-557','EE-56','EE-567','EE-586','EE-60','EE-615','EE-618','EE-622','EE-624','EE-638','EE-64','EE-651','EE-653','EE-661','EE-663','EE-668','EE-68','EE-689','EE-698','EE-708','EE-71','EE-712','EE-714','EE-719','EE-726','EE-732','EE-735','EE-74','EE-784','EE-79','EE-792','EE-793','EE-796','EE-803','EE-809','EE-81','EE-824','EE-834','EE-84','EE-855','EE-87','EE-890','EE-897','EE-899','EE-901','EE-903','EE-907','EE-917','EE-919','EE-928','EG-ALX','EG-ASN','EG-AST','EG-BA','EG-BH','EG-BNS','EG-C','EG-DK','EG-DT','EG-FYM','EG-GH','EG-GZ','EG-IS','EG-JS','EG-KB','EG-KFS','EG-KN','EG-LX','EG-MN','EG-MNF','EG-MT','EG-PTS','EG-SHG','EG-SHR','EG-SIN','EG-SUZ','EG-WAD','ER-AN','ER-DK','ER-DU','ER-GB','ER-MA','ER-SK','ES-A','ES-AB','ES-AL','ES-AN','ES-AR','ES-AS','ES-AV','ES-B','ES-BA','ES-BI','ES-BU','ES-C','ES-CA','ES-CB','ES-CC','ES-CE','ES-CL','ES-CM','ES-CN','ES-CO','ES-CR','ES-CS','ES-CT','ES-CU','ES-EX','ES-GA','ES-GC','ES-GI','ES-GR','ES-GU','ES-H','ES-HU','ES-IB','ES-J','ES-L','ES-LE','ES-LO','ES-LU','ES-M','ES-MA','ES-MC','ES-MD','ES-ML','ES-MU','ES-NA','ES-NC','ES-O','ES-OR','ES-P','ES-PM','ES-PO','ES-PV','ES-RI','ES-S','ES-SA','ES-SE','ES-SG','ES-SO','ES-SS','ES-T','ES-TE','ES-TF','ES-TO','ES-V','ES-VA','ES-VC','ES-VI','ES-Z','ES-ZA','ET-AA','ET-AF','ET-AM','ET-BE','ET-DD','ET-GA','ET-HA','ET-OR','ET-SI','ET-SN','ET-SO','ET-SW','ET-TI','FI-01','FI-02','FI-03','FI-04','FI-05','FI-06','FI-07','FI-08','FI-09','FI-10','FI-11','FI-12','FI-13','FI-14','FI-15','FI-16','FI-17','FI-18','FI-19','FJ-01','FJ-02','FJ-03','FJ-04','FJ-05','FJ-06','FJ-07','FJ-08','FJ-09','FJ-10','FJ-11','FJ-12','FJ-13','FJ-14','FJ-C','FJ-E','FJ-N','FJ-R','FJ-W','FM-KSA','FM-PNI','FM-TRK','FM-YAP','FR-01','FR-02','FR-03','FR-04','FR-05','FR-06','FR-07','FR-08','FR-09','FR-10','FR-11','FR-12','FR-13','FR-14','FR-15','FR-16','FR-17','FR-18','FR-19','FR-20R','FR-21','FR-22','FR-23','FR-24','FR-25','FR-26','FR-27','FR-28','FR-29','FR-2A','FR-2B','FR-30','FR-31','FR-32','FR-33','FR-34','FR-35','FR-36','FR-37','FR-38','FR-39','FR-40','FR-41','FR-42','FR-43','FR-44','FR-45','FR-46','FR-47','FR-48','FR-49','FR-50','FR-51','FR-52','FR-53','FR-54','FR-55','FR-56','FR-57','FR-58','FR-59','FR-60','FR-61','FR-62','FR-63','FR-64','FR-65','FR-66','FR-67','FR-68','FR-69','FR-69M','FR-6AE','FR-70','FR-71','FR-72','FR-73','FR-74','FR-75C','FR-76','FR-77','FR-78','FR-79','FR-80','FR-81','FR-82','FR-83','FR-84','FR-85','FR-86','FR-87','FR-88','FR-89','FR-90','FR-91','FR-92','FR-93','FR-94','FR-95','FR-971','FR-972','FR-973','FR-974','FR-976','FR-ARA','FR-BFC','FR-BL','FR-BRE','FR-CP','FR-CVL','FR-GES','FR-HDF','FR-IDF','FR-MF','FR-NAQ','FR-NC','FR-NOR','FR-OCC','FR-PAC','FR-PDL','FR-PF','FR-PM','FR-TF','FR-WF','GA-1','GA-2','GA-3','GA-4','GA-5','GA-6','GA-7','GA-8','GA-9','GB-ABC','GB-ABD','GB-ABE','GB-AGB','GB-AGY','GB-AND','GB-ANN','GB-ANS','GB-BAS','GB-BBD','GB-BCP','GB-BDF','GB-BDG','GB-BEN','GB-BEX','GB-BFS','GB-BGE','GB-BGW','GB-BIR','GB-BKM','GB-BNE','GB-BNH','GB-BNS','GB-BOL','GB-BPL','GB-BRC','GB-BRD','GB-BRY','GB-BST','GB-BUR','GB-CAM','GB-CAY','GB-CBF','GB-CCG','GB-CGN','GB-CHE','GB-CHW','GB-CLD','GB-CLK','GB-CMA','GB-CMD','GB-CMN','GB-CON','GB-COV','GB-CRF','GB-CRY','GB-CWY','GB-DAL','GB-DBY','GB-DEN','GB-DER','GB-DEV','GB-DGY','GB-DNC','GB-DND','GB-DOR','GB-DRS','GB-DUD','GB-DUR','GB-EAL','GB-EAY','GB-EDH','GB-EDU','GB-ELN','GB-ELS','GB-ENF','GB-ENG','GB-ERW','GB-ERY','GB-ESS','GB-ESX','GB-FAL','GB-FIF','GB-FLN','GB-FMO','GB-GAT','GB-GLG','GB-GLS','GB-GRE','GB-GWN','GB-HAL','GB-HAM','GB-HAV','GB-HCK','GB-HEF','GB-HIL','GB-HLD','GB-HMF','GB-HNS','GB-HPL','GB-HRT','GB-HRW','GB-HRY','GB-IOS','GB-IOW','GB-ISL','GB-IVC','GB-KEC','GB-KEN','GB-KHL','GB-KIR','GB-KTT','GB-KWL','GB-LAN','GB-LBC','GB-LBH','GB-LCE','GB-LDS','GB-LEC','GB-LEW','GB-LIN','GB-LIV','GB-LND','GB-LUT','GB-MAN','GB-MDB','GB-MDW','GB-MEA','GB-MIK','GB-MLN','GB-MON','GB-MRT','GB-MRY','GB-MTY','GB-MUL','GB-NAY','GB-NBL','GB-NEL','GB-NET','GB-NFK','GB-NGM','GB-NIR','GB-NLK','GB-NLN','GB-NMD','GB-NNH','GB-NSM','GB-NTL','GB-NTT','GB-NTY','GB-NWM','GB-NWP','GB-NYK','GB-OLD','GB-ORK','GB-OXF','GB-PEM','GB-PKN','GB-PLY','GB-POR','GB-POW','GB-PTE','GB-RCC','GB-RCH','GB-RCT','GB-RDB','GB-RDG','GB-RFW','GB-RIC','GB-ROT','GB-RUT','GB-SAW','GB-SAY','GB-SCB','GB-SCT','GB-SFK','GB-SFT','GB-SGC','GB-SHF','GB-SHN','GB-SHR','GB-SKP','GB-SLF','GB-SLG','GB-SLK','GB-SND','GB-SOL','GB-SOM','GB-SOS','GB-SRY','GB-STE','GB-STG','GB-STH','GB-STN','GB-STS','GB-STT','GB-STY','GB-SWA','GB-SWD','GB-SWK','GB-TAM','GB-TFW','GB-THR','GB-TOB','GB-TOF','GB-TRF','GB-TWH','GB-VGL','GB-WAR','GB-WBK','GB-WDU','GB-WFT','GB-WGN','GB-WIL','GB-WKF','GB-WLL','GB-WLN','GB-WLS','GB-WLV','GB-WND','GB-WNH','GB-WNM','GB-WOK','GB-WOR','GB-WRL','GB-WRT','GB-WRX','GB-WSM','GB-WSX','GB-YOR','GB-ZET','GD-01','GD-02','GD-03','GD-04','GD-05','GD-06','GD-10','GE-AB','GE-AJ','GE-GU','GE-IM','GE-KA','GE-KK','GE-MM','GE-RL','GE-SJ','GE-SK','GE-SZ','GE-TB','GH-AA','GH-AF','GH-AH','GH-BE','GH-BO','GH-CP','GH-EP','GH-NE','GH-NP','GH-OT','GH-SV','GH-TV','GH-UE','GH-UW','GH-WN','GH-WP','GL-AV','GL-KU','GL-QE','GL-QT','GL-SM','GM-B','GM-L','GM-M','GM-N','GM-U','GM-W','GN-B','GN-BE','GN-BF','GN-BK','GN-C','GN-CO','GN-D','GN-DB','GN-DI','GN-DL','GN-DU','GN-F','GN-FA','GN-FO','GN-FR','GN-GA','GN-GU','GN-K','GN-KA','GN-KB','GN-KD','GN-KE','GN-KN','GN-KO','GN-KS','GN-L','GN-LA','GN-LE','GN-LO','GN-M','GN-MC','GN-MD','GN-ML','GN-MM','GN-N','GN-NZ','GN-PI','GN-SI','GN-TE','GN-TO','GN-YO','GQ-AN','GQ-BN','GQ-BS','GQ-C','GQ-CS','GQ-DJ','GQ-I','GQ-KN','GQ-LI','GQ-WN','GR-69','GR-A','GR-B','GR-C','GR-D','GR-E','GR-F','GR-G','GR-H','GR-I','GR-J','GR-K','GR-L','GR-M','GT-01','GT-02','GT-03','GT-04','GT-05','GT-06','GT-07','GT-08','GT-09','GT-10','GT-11','GT-12','GT-13','GT-14','GT-15','GT-16','GT-17','GT-18','GT-19','GT-20','GT-21','GT-22','GW-BA','GW-BL','GW-BM','GW-BS','GW-CA','GW-GA','GW-L','GW-N','GW-OI','GW-QU','GW-S','GW-TO','GY-BA','GY-CU','GY-DE','GY-EB','GY-ES','GY-MA','GY-PM','GY-PT','GY-UD','GY-UT','HN-AT','HN-CH','HN-CL','HN-CM','HN-CP','HN-CR','HN-EP','HN-FM','HN-GD','HN-IB','HN-IN','HN-LE','HN-LP','HN-OC','HN-OL','HN-SB','HN-VA','HN-YO','HR-01','HR-02','HR-03','HR-04','HR-05','HR-06','HR-07','HR-08','HR-09','HR-10','HR-11','HR-12','HR-13','HR-14','HR-15','HR-16','HR-17','HR-18','HR-19','HR-20','HR-21','HT-AR','HT-CE','HT-GA','HT-ND','HT-NE','HT-NI','HT-NO','HT-OU','HT-SD','HT-SE','HU-BA','HU-BC','HU-BE','HU-BK','HU-BU','HU-BZ','HU-CS','HU-DE','HU-DU','HU-EG','HU-ER','HU-FE','HU-GS','HU-GY','HU-HB','HU-HE','HU-HV','HU-JN','HU-KE','HU-KM','HU-KV','HU-MI','HU-NK','HU-NO','HU-NY','HU-PE','HU-PS','HU-SD','HU-SF','HU-SH','HU-SK','HU-SN','HU-SO','HU-SS','HU-ST','HU-SZ','HU-TB','HU-TO','HU-VA','HU-VE','HU-VM','HU-ZA','HU-ZE','ID-AC','ID-BA','ID-BB','ID-BE','ID-BT','ID-GO','ID-JA','ID-JB','ID-JI','ID-JK','ID-JT','ID-JW','ID-KA','ID-KB','ID-KI','ID-KR','ID-KS','ID-KT','ID-KU','ID-LA','ID-MA','ID-ML','ID-MU','ID-NB','ID-NT','ID-NU','ID-PA','ID-PB','ID-PD','ID-PE','ID-PP','ID-PS','ID-PT','ID-RI','ID-SA','ID-SB','ID-SG','ID-SL','ID-SM','ID-SN','ID-SR','ID-SS','ID-ST','ID-SU','ID-YO','IE-C','IE-CE','IE-CN','IE-CO','IE-CW','IE-D','IE-DL','IE-G','IE-KE','IE-KK','IE-KY','IE-L','IE-LD','IE-LH','IE-LK','IE-LM','IE-LS','IE-M','IE-MH','IE-MN','IE-MO','IE-OY','IE-RN','IE-SO','IE-TA','IE-U','IE-WD','IE-WH','IE-WW','IE-WX','IL-D','IL-HA','IL-JM','IL-M','IL-TA','IL-Z','IN-AN','IN-AP','IN-AR','IN-AS','IN-BR','IN-CG','IN-CH','IN-DH','IN-DL','IN-GA','IN-GJ','IN-HP','IN-HR','IN-JH','IN-JK','IN-KA','IN-KL','IN-LA','IN-LD','IN-MH','IN-ML','IN-MN','IN-MP','IN-MZ','IN-NL','IN-OD','IN-PB','IN-PY','IN-RJ','IN-SK','IN-TN','IN-TR','IN-TS','IN-UK','IN-UP','IN-WB','IQ-AN','IQ-AR','IQ-BA','IQ-BB','IQ-BG','IQ-DA','IQ-DI','IQ-DQ','IQ-KA','IQ-KI','IQ-KR','IQ-MA','IQ-MU','IQ-NA','IQ-NI','IQ-QA','IQ-SD','IQ-SU','IQ-WA','IR-00','IR-01','IR-02','IR-03','IR-04','IR-05','IR-06','IR-07','IR-08','IR-09','IR-10','IR-11','IR-12','IR-13','IR-14','IR-15','IR-16','IR-17','IR-18','IR-19','IR-20','IR-21','IR-22','IR-23','IR-24','IR-25','IR-26','IR-27','IR-28','IR-29','IR-30','IS-1','IS-2','IS-3','IS-4','IS-5','IS-6','IS-7','IS-8','IS-AKN','IS-AKU','IS-ARN','IS-ASA','IS-BLA','IS-BOG','IS-BOL','IS-DAB','IS-DAV','IS-EOM','IS-EYF','IS-FJD','IS-FJL','IS-FLA','IS-FLR','IS-GAR','IS-GOG','IS-GRN','IS-GRU','IS-GRY','IS-HAF','IS-HRG','IS-HRU','IS-HUG','IS-HUV','IS-HVA','IS-HVE','IS-ISA','IS-KAL','IS-KJO','IS-KOP','IS-LAN','IS-MOS','IS-MUL','IS-MYR','IS-NOR','IS-RGE','IS-RGY','IS-RHH','IS-RKN','IS-RKV','IS-SBT','IS-SDN','IS-SDV','IS-SEL','IS-SFA','IS-SHF','IS-SKF','IS-SKG','IS-SKO','IS-SKR','IS-SNF','IS-SOG','IS-SOL','IS-SSS','IS-STR','IS-STY','IS-SVG','IS-TAL','IS-THG','IS-TJO','IS-VEM','IS-VER','IS-VOP','IT-21','IT-23','IT-25','IT-32','IT-34','IT-36','IT-42','IT-45','IT-52','IT-55','IT-57','IT-62','IT-65','IT-67','IT-72','IT-75','IT-77','IT-78','IT-82','IT-88','IT-AG','IT-AL','IT-AN','IT-AP','IT-AQ','IT-AR','IT-AT','IT-AV','IT-BA','IT-BG','IT-BI','IT-BL','IT-BN','IT-BO','IT-BR','IT-BS','IT-BT','IT-BZ','IT-CA','IT-CB','IT-CE','IT-CH','IT-CL','IT-CN','IT-CO','IT-CR','IT-CS','IT-CT','IT-CZ','IT-EN','IT-FC','IT-FE','IT-FG','IT-FI','IT-FM','IT-FR','IT-GE','IT-GO','IT-GR','IT-IM','IT-IS','IT-KR','IT-LC','IT-LE','IT-LI','IT-LO','IT-LT','IT-LU','IT-MB','IT-MC','IT-ME','IT-MI','IT-MN','IT-MO','IT-MS','IT-MT','IT-NA','IT-NO','IT-NU','IT-OR','IT-PA','IT-PC','IT-PD','IT-PE','IT-PG','IT-PI','IT-PN','IT-PO','IT-PR','IT-PT','IT-PU','IT-PV','IT-PZ','IT-RA','IT-RC','IT-RE','IT-RG','IT-RI','IT-RM','IT-RN','IT-RO','IT-SA','IT-SI','IT-SO','IT-SP','IT-SR','IT-SS','IT-SU','IT-SV','IT-TA','IT-TE','IT-TN','IT-TO','IT-TP','IT-TR','IT-TS','IT-TV','IT-UD','IT-VA','IT-VB','IT-VC','IT-VE','IT-VI','IT-VR','IT-VT','IT-VV','JM-01','JM-02','JM-03','JM-04','JM-05','JM-06','JM-07','JM-08','JM-09','JM-10','JM-11','JM-12','JM-13','JM-14','JO-AJ','JO-AM','JO-AQ','JO-AT','JO-AZ','JO-BA','JO-IR','JO-JA','JO-KA','JO-MA','JO-MD','JO-MN','JP-01','JP-02','JP-03','JP-04','JP-05','JP-06','JP-07','JP-08','JP-09','JP-10','JP-11','JP-12','JP-13','JP-14','JP-15','JP-16','JP-17','JP-18','JP-19','JP-20','JP-21','JP-22','JP-23','JP-24','JP-25','JP-26','JP-27','JP-28','JP-29','JP-30','JP-31','JP-32','JP-33','JP-34','JP-35','JP-36','JP-37','JP-38','JP-39','JP-40','JP-41','JP-42','JP-43','JP-44','JP-45','JP-46','JP-47','KE-01','KE-02','KE-03','KE-04','KE-05','KE-06','KE-07','KE-08','KE-09','KE-10','KE-11','KE-12','KE-13','KE-14','KE-15','KE-16','KE-17','KE-18','KE-19','KE-20','KE-21','KE-22','KE-23','KE-24','KE-25','KE-26','KE-27','KE-28','KE-29','KE-30','KE-31','KE-32','KE-33','KE-34','KE-35','KE-36','KE-37','KE-38','KE-39','KE-40','KE-41','KE-42','KE-43','KE-44','KE-45','KE-46','KE-47','KG-B','KG-C','KG-GB','KG-GO','KG-J','KG-N','KG-O','KG-T','KG-Y','KH-1','KH-10','KH-11','KH-12','KH-13','KH-14','KH-15','KH-16','KH-17','KH-18','KH-19','KH-2','KH-20','KH-21','KH-22','KH-23','KH-24','KH-25','KH-3','KH-4','KH-5','KH-6','KH-7','KH-8','KH-9','KI-G','KI-L','KI-P','KM-A','KM-G','KM-M','KN-01','KN-02','KN-03','KN-04','KN-05','KN-06','KN-07','KN-08','KN-09','KN-10','KN-11','KN-12','KN-13','KN-15','KN-K','KN-N','KP-01','KP-02','KP-03','KP-04','KP-05','KP-06','KP-07','KP-08','KP-09','KP-10','KP-13','KP-14','KP-15','KR-11','KR-26','KR-27','KR-28','KR-29','KR-30','KR-31','KR-41','KR-42','KR-43','KR-44','KR-45','KR-46','KR-47','KR-48','KR-49','KR-50','KW-AH','KW-FA','KW-HA','KW-JA','KW-KU','KW-MU','KZ-10','KZ-11','KZ-15','KZ-19','KZ-23','KZ-27','KZ-31','KZ-33','KZ-35','KZ-39','KZ-43','KZ-47','KZ-55','KZ-59','KZ-61','KZ-62','KZ-63','KZ-71','KZ-75','KZ-79','LA-AT','LA-BK','LA-BL','LA-CH','LA-HO','LA-KH','LA-LM','LA-LP','LA-OU','LA-PH','LA-SL','LA-SV','LA-VI','LA-VT','LA-XA','LA-XE','LA-XI','LA-XS','LB-AK','LB-AS','LB-BA','LB-BH','LB-BI','LB-JA','LB-JL','LB-NA','LC-01','LC-02','LC-03','LC-05','LC-06','LC-07','LC-08','LC-10','LC-11','LC-12','LI-01','LI-02','LI-03','LI-04','LI-05','LI-06','LI-07','LI-08','LI-09','LI-10','LI-11','LK-1','LK-11','LK-12','LK-13','LK-2','LK-21','LK-22','LK-23','LK-3','LK-31','LK-32','LK-33','LK-4','LK-41','LK-42','LK-43','LK-44','LK-45','LK-5','LK-51','LK-52','LK-53','LK-6','LK-61','LK-62','LK-7','LK-71','LK-72','LK-8','LK-81','LK-82','LK-9','LK-91','LK-92','LR-BG','LR-BM','LR-CM','LR-GB','LR-GG','LR-GK','LR-GP','LR-LO','LR-MG','LR-MO','LR-MY','LR-NI','LR-RG','LR-RI','LR-SI','LS-A','LS-B','LS-C','LS-D','LS-E','LS-F','LS-G','LS-H','LS-J','LS-K','LT-01','LT-02','LT-03','LT-04','LT-05','LT-06','LT-07','LT-08','LT-09','LT-10','LT-11','LT-12','LT-13','LT-14','LT-15','LT-16','LT-17','LT-18','LT-19','LT-20','LT-21','LT-22','LT-23','LT-24','LT-25','LT-26','LT-27','LT-28','LT-29','LT-30','LT-31','LT-32','LT-33','LT-34','LT-35','LT-36','LT-37','LT-38','LT-39','LT-40','LT-41','LT-42','LT-43','LT-44','LT-45','LT-46','LT-47','LT-48','LT-49','LT-50','LT-51','LT-52','LT-53','LT-54','LT-55','LT-56','LT-57','LT-58','LT-59','LT-60','LT-AL','LT-KL','LT-KU','LT-MR','LT-PN','LT-SA','LT-TA','LT-TE','LT-UT','LT-VL','LU-CA','LU-CL','LU-DI','LU-EC','LU-ES','LU-GR','LU-LU','LU-ME','LU-RD','LU-RM','LU-VD','LU-WI','LV-002','LV-007','LV-011','LV-015','LV-016','LV-022','LV-026','LV-033','LV-041','LV-042','LV-047','LV-050','LV-052','LV-054','LV-056','LV-058','LV-059','LV-062','LV-067','LV-068','LV-073','LV-077','LV-080','LV-087','LV-088','LV-089','LV-091','LV-094','LV-097','LV-099','LV-101','LV-102','LV-106','LV-111','LV-112','LV-113','LV-DGV','LV-JEL','LV-JUR','LV-LPX','LV-REZ','LV-RIX','LV-VEN','LY-BA','LY-BU','LY-DR','LY-GT','LY-JA','LY-JG','LY-JI','LY-JU','LY-KF','LY-MB','LY-MI','LY-MJ','LY-MQ','LY-NL','LY-NQ','LY-SB','LY-SR','LY-TB','LY-WA','LY-WD','LY-WS','LY-ZA','MA-01','MA-02','MA-03','MA-04','MA-05','MA-06','MA-07','MA-08','MA-09','MA-10','MA-11','MA-12','MA-AGD','MA-AOU','MA-ASZ','MA-AZI','MA-BEM','MA-BER','MA-BES','MA-BOD','MA-BOM','MA-BRR','MA-CAS','MA-CHE','MA-CHI','MA-CHT','MA-DRI','MA-ERR','MA-ESI','MA-ESM','MA-FAH','MA-FES','MA-FIG','MA-FQH','MA-GUE','MA-GUF','MA-HAJ','MA-HAO','MA-HOC','MA-IFR','MA-INE','MA-JDI','MA-JRA','MA-KEN','MA-KES','MA-KHE','MA-KHN','MA-KHO','MA-LAA','MA-LAR','MA-MAR','MA-MDF','MA-MED','MA-MEK','MA-MID','MA-MOH','MA-MOU','MA-NAD','MA-NOU','MA-OUA','MA-OUD','MA-OUJ','MA-OUZ','MA-RAB','MA-REH','MA-SAF','MA-SAL','MA-SEF','MA-SET','MA-SIB','MA-SIF','MA-SIK','MA-SIL','MA-SKH','MA-TAF','MA-TAI','MA-TAO','MA-TAR','MA-TAT','MA-TAZ','MA-TET','MA-TIN','MA-TIZ','MA-TNG','MA-TNT','MA-YUS','MA-ZAG','MC-CL','MC-CO','MC-FO','MC-GA','MC-JE','MC-LA','MC-MA','MC-MC','MC-MG','MC-MO','MC-MU','MC-PH','MC-SD','MC-SO','MC-SP','MC-SR','MC-VR','MD-AN','MD-BA','MD-BD','MD-BR','MD-BS','MD-CA','MD-CL','MD-CM','MD-CR','MD-CS','MD-CT','MD-CU','MD-DO','MD-DR','MD-DU','MD-ED','MD-FA','MD-FL','MD-GA','MD-GL','MD-HI','MD-IA','MD-LE','MD-NI','MD-OC','MD-OR','MD-RE','MD-RI','MD-SD','MD-SI','MD-SN','MD-SO','MD-ST','MD-SV','MD-TA','MD-TE','MD-UN','ME-01','ME-02','ME-03','ME-04','ME-05','ME-06','ME-07','ME-08','ME-09','ME-10','ME-11','ME-12','ME-13','ME-14','ME-15','ME-16','ME-17','ME-18','ME-19','ME-20','ME-21','ME-22','ME-23','ME-24','ME-25','MG-A','MG-D','MG-F','MG-M','MG-T','MG-U','MH-ALK','MH-ALL','MH-ARN','MH-AUR','MH-EBO','MH-ENI','MH-JAB','MH-JAL','MH-KIL','MH-KWA','MH-L','MH-LAE','MH-LIB','MH-LIK','MH-MAJ','MH-MAL','MH-MEJ','MH-MIL','MH-NMK','MH-NMU','MH-RON','MH-T','MH-UJA','MH-UTI','MH-WTH','MH-WTJ','MK-101','MK-102','MK-103','MK-104','MK-105','MK-106','MK-107','MK-108','MK-109','MK-201','MK-202','MK-203','MK-204','MK-205','MK-206','MK-207','MK-208','MK-209','MK-210','MK-211','MK-301','MK-303','MK-304','MK-307','MK-308','MK-310','MK-311','MK-312','MK-313','MK-401','MK-402','MK-403','MK-404','MK-405','MK-406','MK-407','MK-408','MK-409','MK-410','MK-501','MK-502','MK-503','MK-504','MK-505','MK-506','MK-507','MK-508','MK-509','MK-601','MK-602','MK-603','MK-604','MK-605','MK-606','MK-607','MK-608','MK-609','MK-701','MK-702','MK-703','MK-704','MK-705','MK-706','MK-801','MK-802','MK-803','MK-804','MK-805','MK-806','MK-807','MK-808','MK-809','MK-810','MK-811','MK-812','MK-813','MK-814','MK-815','MK-816','MK-817','ML-1','ML-10','ML-2','ML-3','ML-4','ML-5','ML-6','ML-7','ML-8','ML-9','ML-BKO','MM-01','MM-02','MM-03','MM-04','MM-05','MM-06','MM-07','MM-11','MM-12','MM-13','MM-14','MM-15','MM-16','MM-17','MM-18','MN-035','MN-037','MN-039','MN-041','MN-043','MN-046','MN-047','MN-049','MN-051','MN-053','MN-055','MN-057','MN-059','MN-061','MN-063','MN-064','MN-065','MN-067','MN-069','MN-071','MN-073','MN-1','MR-01','MR-02','MR-03','MR-04','MR-05','MR-06','MR-07','MR-08','MR-09','MR-10','MR-11','MR-12','MR-13','MR-14','MR-15','MT-01','MT-02','MT-03','MT-04','MT-05','MT-06','MT-07','MT-08','MT-09','MT-10','MT-11','MT-12','MT-13','MT-14','MT-15','MT-16','MT-17','MT-18','MT-19','MT-20','MT-21','MT-22','MT-23','MT-24','MT-25','MT-26','MT-27','MT-28','MT-29','MT-30','MT-31','MT-32','MT-33','MT-34','MT-35','MT-36','MT-37','MT-38','MT-39','MT-40','MT-41','MT-42','MT-43','MT-44','MT-45','MT-46','MT-47','MT-48','MT-49','MT-50','MT-51','MT-52','MT-53','MT-54','MT-55','MT-56','MT-57','MT-58','MT-59','MT-60','MT-61','MT-62','MT-63','MT-64','MT-65','MT-66','MT-67','MT-68','MU-AG','MU-BL','MU-CC','MU-FL','MU-GP','MU-MO','MU-PA','MU-PL','MU-PW','MU-RO','MU-RR','MU-SA','MV-00','MV-01','MV-02','MV-03','MV-04','MV-05','MV-07','MV-08','MV-12','MV-13','MV-14','MV-17','MV-20','MV-23','MV-24','MV-25','MV-26','MV-27','MV-28','MV-29','MV-MLE','MW-BA','MW-BL','MW-C','MW-CK','MW-CR','MW-CT','MW-DE','MW-DO','MW-KR','MW-KS','MW-LI','MW-LK','MW-MC','MW-MG','MW-MH','MW-MU','MW-MW','MW-MZ','MW-N','MW-NB','MW-NE','MW-NI','MW-NK','MW-NS','MW-NU','MW-PH','MW-RU','MW-S','MW-SA','MW-TH','MW-ZO','MX-AGU','MX-BCN','MX-BCS','MX-CAM','MX-CHH','MX-CHP','MX-CMX','MX-COA','MX-COL','MX-DUR','MX-GRO','MX-GUA','MX-HID','MX-JAL','MX-MEX','MX-MIC','MX-MOR','MX-NAY','MX-NLE','MX-OAX','MX-PUE','MX-QUE','MX-ROO','MX-SIN','MX-SLP','MX-SON','MX-TAB','MX-TAM','MX-TLA','MX-VER','MX-YUC','MX-ZAC','MY-01','MY-02','MY-03','MY-04','MY-05','MY-06','MY-07','MY-08','MY-09','MY-10','MY-11','MY-12','MY-13','MY-14','MY-15','MY-16','MZ-A','MZ-B','MZ-G','MZ-I','MZ-L','MZ-MPM','MZ-N','MZ-P','MZ-Q','MZ-S','MZ-T','NA-CA','NA-ER','NA-HA','NA-KA','NA-KE','NA-KH','NA-KU','NA-KW','NA-OD','NA-OH','NA-ON','NA-OS','NA-OT','NA-OW','NE-1','NE-2','NE-3','NE-4','NE-5','NE-6','NE-7','NE-8','NG-AB','NG-AD','NG-AK','NG-AN','NG-BA','NG-BE','NG-BO','NG-BY','NG-CR','NG-DE','NG-EB','NG-ED','NG-EK','NG-EN','NG-FC','NG-GO','NG-IM','NG-JI','NG-KD','NG-KE','NG-KN','NG-KO','NG-KT','NG-KW','NG-LA','NG-NA','NG-NI','NG-OG','NG-ON','NG-OS','NG-OY','NG-PL','NG-RI','NG-SO','NG-TA','NG-YO','NG-ZA','NI-AN','NI-AS','NI-BO','NI-CA','NI-CI','NI-CO','NI-ES','NI-GR','NI-JI','NI-LE','NI-MD','NI-MN','NI-MS','NI-MT','NI-NS','NI-RI','NI-SJ','NL-AW','NL-BQ1','NL-BQ2','NL-BQ3','NL-CW','NL-DR','NL-FL','NL-FR','NL-GE','NL-GR','NL-LI','NL-NB','NL-NH','NL-OV','NL-SX','NL-UT','NL-ZE','NL-ZH','NO-03','NO-11','NO-15','NO-18','NO-21','NO-22','NO-30','NO-34','NO-38','NO-42','NO-46','NO-50','NO-54','NP-P1','NP-P2','NP-P3','NP-P4','NP-P5','NP-P6','NP-P7','NR-01','NR-02','NR-03','NR-04','NR-05','NR-06','NR-07','NR-08','NR-09','NR-10','NR-11','NR-12','NR-13','NR-14','NZ-AUK','NZ-BOP','NZ-CAN','NZ-CIT','NZ-GIS','NZ-HKB','NZ-MBH','NZ-MWT','NZ-NSN','NZ-NTL','NZ-OTA','NZ-STL','NZ-TAS','NZ-TKI','NZ-WGN','NZ-WKO','NZ-WTC','OM-BJ','OM-BS','OM-BU','OM-DA','OM-MA','OM-MU','OM-SJ','OM-SS','OM-WU','OM-ZA','OM-ZU','PA-1','PA-10','PA-2','PA-3','PA-4','PA-5','PA-6','PA-7','PA-8','PA-9','PA-EM','PA-KY','PA-NB','PA-NT','PE-AMA','PE-ANC','PE-APU','PE-ARE','PE-AYA','PE-CAJ','PE-CAL','PE-CUS','PE-HUC','PE-HUV','PE-ICA','PE-JUN','PE-LAL','PE-LAM','PE-LIM','PE-LMA','PE-LOR','PE-MDD','PE-MOQ','PE-PAS','PE-PIU','PE-PUN','PE-SAM','PE-TAC','PE-TUM','PE-UCA','PG-CPK','PG-CPM','PG-EBR','PG-EHG','PG-EPW','PG-ESW','PG-GPK','PG-HLA','PG-JWK','PG-MBA','PG-MPL','PG-MPM','PG-MRL','PG-NCD','PG-NIK','PG-NPP','PG-NSB','PG-SAN','PG-SHM','PG-WBK','PG-WHM','PG-WPD','PH-00','PH-01','PH-02','PH-03','PH-05','PH-06','PH-07','PH-08','PH-09','PH-10','PH-11','PH-12','PH-13','PH-14','PH-15','PH-40','PH-41','PH-ABR','PH-AGN','PH-AGS','PH-AKL','PH-ALB','PH-ANT','PH-APA','PH-AUR','PH-BAN','PH-BAS','PH-BEN','PH-BIL','PH-BOH','PH-BTG','PH-BTN','PH-BUK','PH-BUL','PH-CAG','PH-CAM','PH-CAN','PH-CAP','PH-CAS','PH-CAT','PH-CAV','PH-CEB','PH-COM','PH-DAO','PH-DAS','PH-DAV','PH-DIN','PH-DVO','PH-EAS','PH-GUI','PH-IFU','PH-ILI','PH-ILN','PH-ILS','PH-ISA','PH-KAL','PH-LAG','PH-LAN','PH-LAS','PH-LEY','PH-LUN','PH-MAD','PH-MAS','PH-MDC','PH-MDR','PH-MGN','PH-MGS','PH-MOU','PH-MSC','PH-MSR','PH-NCO','PH-NEC','PH-NER','PH-NSA','PH-NUE','PH-NUV','PH-PAM','PH-PAN','PH-PLW','PH-QUE','PH-QUI','PH-RIZ','PH-ROM','PH-SAR','PH-SCO','PH-SIG','PH-SLE','PH-SLU','PH-SOR','PH-SUK','PH-SUN','PH-SUR','PH-TAR','PH-TAW','PH-WSA','PH-ZAN','PH-ZAS','PH-ZMB','PH-ZSI','PK-BA','PK-GB','PK-IS','PK-JK','PK-KP','PK-PB','PK-SD','PL-02','PL-04','PL-06','PL-08','PL-10','PL-12','PL-14','PL-16','PL-18','PL-20','PL-22','PL-24','PL-26','PL-28','PL-30','PL-32','PS-BTH','PS-DEB','PS-GZA','PS-HBN','PS-JEM','PS-JEN','PS-JRH','PS-KYS','PS-NBS','PS-NGZ','PS-QQA','PS-RBH','PS-RFH','PS-SLT','PS-TBS','PS-TKM','PT-01','PT-02','PT-03','PT-04','PT-05','PT-06','PT-07','PT-08','PT-09','PT-10','PT-11','PT-12','PT-13','PT-14','PT-15','PT-16','PT-17','PT-18','PT-20','PT-30','PW-002','PW-004','PW-010','PW-050','PW-100','PW-150','PW-212','PW-214','PW-218','PW-222','PW-224','PW-226','PW-227','PW-228','PW-350','PW-370','PY-1','PY-10','PY-11','PY-12','PY-13','PY-14','PY-15','PY-16','PY-19','PY-2','PY-3','PY-4','PY-5','PY-6','PY-7','PY-8','PY-9','PY-ASU','QA-DA','QA-KH','QA-MS','QA-RA','QA-SH','QA-US','QA-WA','QA-ZA','RO-AB','RO-AG','RO-AR','RO-B','RO-BC','RO-BH','RO-BN','RO-BR','RO-BT','RO-BV','RO-BZ','RO-CJ','RO-CL','RO-CS','RO-CT','RO-CV','RO-DB','RO-DJ','RO-GJ','RO-GL','RO-GR','RO-HD','RO-HR','RO-IF','RO-IL','RO-IS','RO-MH','RO-MM','RO-MS','RO-NT','RO-OT','RO-PH','RO-SB','RO-SJ','RO-SM','RO-SV','RO-TL','RO-TM','RO-TR','RO-VL','RO-VN','RO-VS','RS-00','RS-01','RS-02','RS-03','RS-04','RS-05','RS-06','RS-07','RS-08','RS-09','RS-10','RS-11','RS-12','RS-13','RS-14','RS-15','RS-16','RS-17','RS-18','RS-19','RS-20','RS-21','RS-22','RS-23','RS-24','RS-25','RS-26','RS-27','RS-28','RS-29','RS-KM','RS-VO','RU-AD','RU-AL','RU-ALT','RU-AMU','RU-ARK','RU-AST','RU-BA','RU-BEL','RU-BRY','RU-BU','RU-CE','RU-CHE','RU-CHU','RU-CU','RU-DA','RU-IN','RU-IRK','RU-IVA','RU-KAM','RU-KB','RU-KC','RU-KDA','RU-KEM','RU-KGD','RU-KGN','RU-KHA','RU-KHM','RU-KIR','RU-KK','RU-KL','RU-KLU','RU-KO','RU-KOS','RU-KR','RU-KRS','RU-KYA','RU-LEN','RU-LIP','RU-MAG','RU-ME','RU-MO','RU-MOS','RU-MOW','RU-MUR','RU-NEN','RU-NGR','RU-NIZ','RU-NVS','RU-OMS','RU-ORE','RU-ORL','RU-PER','RU-PNZ','RU-PRI','RU-PSK','RU-ROS','RU-RYA','RU-SA','RU-SAK','RU-SAM','RU-SAR','RU-SE','RU-SMO','RU-SPE','RU-STA','RU-SVE','RU-TA','RU-TAM','RU-TOM','RU-TUL','RU-TVE','RU-TY','RU-TYU','RU-UD','RU-ULY','RU-VGG','RU-VLA','RU-VLG','RU-VOR','RU-YAN','RU-YAR','RU-YEV','RU-ZAB','RW-01','RW-02','RW-03','RW-04','RW-05','SA-01','SA-02','SA-03','SA-04','SA-05','SA-06','SA-07','SA-08','SA-09','SA-10','SA-11','SA-12','SA-14','SB-CE','SB-CH','SB-CT','SB-GU','SB-IS','SB-MK','SB-ML','SB-RB','SB-TE','SB-WE','SC-01','SC-02','SC-03','SC-04','SC-05','SC-06','SC-07','SC-08','SC-09','SC-10','SC-11','SC-12','SC-13','SC-14','SC-15','SC-16','SC-17','SC-18','SC-19','SC-20','SC-21','SC-22','SC-23','SC-24','SC-25','SC-26','SC-27','SD-DC','SD-DE','SD-DN','SD-DS','SD-DW','SD-GD','SD-GK','SD-GZ','SD-KA','SD-KH','SD-KN','SD-KS','SD-NB','SD-NO','SD-NR','SD-NW','SD-RS','SD-SI','SE-AB','SE-AC','SE-BD','SE-C','SE-D','SE-E','SE-F','SE-G','SE-H','SE-I','SE-K','SE-M','SE-N','SE-O','SE-S','SE-T','SE-U','SE-W','SE-X','SE-Y','SE-Z','SG-01','SG-02','SG-03','SG-04','SG-05','SH-AC','SH-HL','SH-TA','SI-001','SI-002','SI-003','SI-004','SI-005','SI-006','SI-007','SI-008','SI-009','SI-010','SI-011','SI-012','SI-013','SI-014','SI-015','SI-016','SI-017','SI-018','SI-019','SI-020','SI-021','SI-022','SI-023','SI-024','SI-025','SI-026','SI-027','SI-028','SI-029','SI-030','SI-031','SI-032','SI-033','SI-034','SI-035','SI-036','SI-037','SI-038','SI-039','SI-040','SI-041','SI-042','SI-043','SI-044','SI-045','SI-046','SI-047','SI-048','SI-049','SI-050','SI-051','SI-052','SI-053','SI-054','SI-055','SI-056','SI-057','SI-058','SI-059','SI-060','SI-061','SI-062','SI-063','SI-064','SI-065','SI-066','SI-067','SI-068','SI-069','SI-070','SI-071','SI-072','SI-073','SI-074','SI-075','SI-076','SI-077','SI-078','SI-079','SI-080','SI-081','SI-082','SI-083','SI-084','SI-085','SI-086','SI-087','SI-088','SI-089','SI-090','SI-091','SI-092','SI-093','SI-094','SI-095','SI-096','SI-097','SI-098','SI-099','SI-100','SI-101','SI-102','SI-103','SI-104','SI-105','SI-106','SI-107','SI-108','SI-109','SI-110','SI-111','SI-112','SI-113','SI-114','SI-115','SI-116','SI-117','SI-118','SI-119','SI-120','SI-121','SI-122','SI-123','SI-124','SI-125','SI-126','SI-127','SI-128','SI-129','SI-130','SI-131','SI-132','SI-133','SI-134','SI-135','SI-136','SI-137','SI-138','SI-139','SI-140','SI-141','SI-142','SI-143','SI-144','SI-146','SI-147','SI-148','SI-149','SI-150','SI-151','SI-152','SI-153','SI-154','SI-155','SI-156','SI-157','SI-158','SI-159','SI-160','SI-161','SI-162','SI-163','SI-164','SI-165','SI-166','SI-167','SI-168','SI-169','SI-170','SI-171','SI-172','SI-173','SI-174','SI-175','SI-176','SI-177','SI-178','SI-179','SI-180','SI-181','SI-182','SI-183','SI-184','SI-185','SI-186','SI-187','SI-188','SI-189','SI-190','SI-191','SI-192','SI-193','SI-194','SI-195','SI-196','SI-197','SI-198','SI-199','SI-200','SI-201','SI-202','SI-203','SI-204','SI-205','SI-206','SI-207','SI-208','SI-209','SI-210','SI-211','SI-212','SI-213','SK-BC','SK-BL','SK-KI','SK-NI','SK-PV','SK-TA','SK-TC','SK-ZI','SL-E','SL-N','SL-NW','SL-S','SL-W','SM-01','SM-02','SM-03','SM-04','SM-05','SM-06','SM-07','SM-08','SM-09','SN-DB','SN-DK','SN-FK','SN-KA','SN-KD','SN-KE','SN-KL','SN-LG','SN-MT','SN-SE','SN-SL','SN-TC','SN-TH','SN-ZG','SO-AW','SO-BK','SO-BN','SO-BR','SO-BY','SO-GA','SO-GE','SO-HI','SO-JD','SO-JH','SO-MU','SO-NU','SO-SA','SO-SD','SO-SH','SO-SO','SO-TO','SO-WO','SR-BR','SR-CM','SR-CR','SR-MA','SR-NI','SR-PM','SR-PR','SR-SA','SR-SI','SR-WA','SS-BN','SS-BW','SS-EC','SS-EE','SS-EW','SS-JG','SS-LK','SS-NU','SS-UY','SS-WR','ST-01','ST-02','ST-03','ST-04','ST-05','ST-06','ST-P','SV-AH','SV-CA','SV-CH','SV-CU','SV-LI','SV-MO','SV-PA','SV-SA','SV-SM','SV-SO','SV-SS','SV-SV','SV-UN','SV-US','SY-DI','SY-DR','SY-DY','SY-HA','SY-HI','SY-HL','SY-HM','SY-ID','SY-LA','SY-QU','SY-RA','SY-RD','SY-SU','SY-TA','SZ-HH','SZ-LU','SZ-MA','SZ-SH','TD-BA','TD-BG','TD-BO','TD-CB','TD-EE','TD-EO','TD-GR','TD-HL','TD-KA','TD-LC','TD-LO','TD-LR','TD-MA','TD-MC','TD-ME','TD-MO','TD-ND','TD-OD','TD-SA','TD-SI','TD-TA','TD-TI','TD-WF','TG-C','TG-K','TG-M','TG-P','TG-S','TH-10','TH-11','TH-12','TH-13','TH-14','TH-15','TH-16','TH-17','TH-18','TH-19','TH-20','TH-21','TH-22','TH-23','TH-24','TH-25','TH-26','TH-27','TH-30','TH-31','TH-32','TH-33','TH-34','TH-35','TH-36','TH-37','TH-38','TH-39','TH-40','TH-41','TH-42','TH-43','TH-44','TH-45','TH-46','TH-47','TH-48','TH-49','TH-50','TH-51','TH-52','TH-53','TH-54','TH-55','TH-56','TH-57','TH-58','TH-60','TH-61','TH-62','TH-63','TH-64','TH-65','TH-66','TH-67','TH-70','TH-71','TH-72','TH-73','TH-74','TH-75','TH-76','TH-77','TH-80','TH-81','TH-82','TH-83','TH-84','TH-85','TH-86','TH-90','TH-91','TH-92','TH-93','TH-94','TH-95','TH-96','TH-S','TJ-DU','TJ-GB','TJ-KT','TJ-RA','TJ-SU','TL-AL','TL-AN','TL-BA','TL-BO','TL-CO','TL-DI','TL-ER','TL-LA','TL-LI','TL-MF','TL-MT','TL-OE','TL-VI','TM-A','TM-B','TM-D','TM-L','TM-M','TM-S','TN-11','TN-12','TN-13','TN-14','TN-21','TN-22','TN-23','TN-31','TN-32','TN-33','TN-34','TN-41','TN-42','TN-43','TN-51','TN-52','TN-53','TN-61','TN-71','TN-72','TN-73','TN-81','TN-82','TN-83','TO-01','TO-02','TO-03','TO-04','TO-05','TR-01','TR-02','TR-03','TR-04','TR-05','TR-06','TR-07','TR-08','TR-09','TR-10','TR-11','TR-12','TR-13','TR-14','TR-15','TR-16','TR-17','TR-18','TR-19','TR-20','TR-21','TR-22','TR-23','TR-24','TR-25','TR-26','TR-27','TR-28','TR-29','TR-30','TR-31','TR-32','TR-33','TR-34','TR-35','TR-36','TR-37','TR-38','TR-39','TR-40','TR-41','TR-42','TR-43','TR-44','TR-45','TR-46','TR-47','TR-48','TR-49','TR-50','TR-51','TR-52','TR-53','TR-54','TR-55','TR-56','TR-57','TR-58','TR-59','TR-60','TR-61','TR-62','TR-63','TR-64','TR-65','TR-66','TR-67','TR-68','TR-69','TR-70','TR-71','TR-72','TR-73','TR-74','TR-75','TR-76','TR-77','TR-78','TR-79','TR-80','TR-81','TT-ARI','TT-CHA','TT-CTT','TT-DMN','TT-MRC','TT-PED','TT-POS','TT-PRT','TT-PTF','TT-SFO','TT-SGE','TT-SIP','TT-SJL','TT-TOB','TT-TUP','TV-FUN','TV-NIT','TV-NKF','TV-NKL','TV-NMA','TV-NMG','TV-NUI','TV-VAI','TW-CHA','TW-CYI','TW-CYQ','TW-HSQ','TW-HSZ','TW-HUA','TW-ILA','TW-KEE','TW-KHH','TW-KIN','TW-LIE','TW-MIA','TW-NAN','TW-NWT','TW-PEN','TW-PIF','TW-TAO','TW-TNN','TW-TPE','TW-TTT','TW-TXG','TW-YUN','TZ-01','TZ-02','TZ-03','TZ-04','TZ-05','TZ-06','TZ-07','TZ-08','TZ-09','TZ-10','TZ-11','TZ-12','TZ-13','TZ-14','TZ-15','TZ-16','TZ-17','TZ-18','TZ-19','TZ-20','TZ-21','TZ-22','TZ-23','TZ-24','TZ-25','TZ-26','TZ-27','TZ-28','TZ-29','TZ-30','TZ-31','UA-05','UA-07','UA-09','UA-12','UA-14','UA-18','UA-21','UA-23','UA-26','UA-30','UA-32','UA-35','UA-40','UA-43','UA-46','UA-48','UA-51','UA-53','UA-56','UA-59','UA-61','UA-63','UA-65','UA-68','UA-71','UA-74','UA-77','UG-101','UG-102','UG-103','UG-104','UG-105','UG-106','UG-107','UG-108','UG-109','UG-110','UG-111','UG-112','UG-113','UG-114','UG-115','UG-116','UG-117','UG-118','UG-119','UG-120','UG-121','UG-122','UG-123','UG-124','UG-125','UG-126','UG-201','UG-202','UG-203','UG-204','UG-205','UG-206','UG-207','UG-208','UG-209','UG-210','UG-211','UG-212','UG-213','UG-214','UG-215','UG-216','UG-217','UG-218','UG-219','UG-220','UG-221','UG-222','UG-223','UG-224','UG-225','UG-226','UG-227','UG-228','UG-229','UG-230','UG-231','UG-232','UG-233','UG-234','UG-235','UG-236','UG-237','UG-301','UG-302','UG-303','UG-304','UG-305','UG-306','UG-307','UG-308','UG-309','UG-310','UG-311','UG-312','UG-313','UG-314','UG-315','UG-316','UG-317','UG-318','UG-319','UG-320','UG-321','UG-322','UG-323','UG-324','UG-325','UG-326','UG-327','UG-328','UG-329','UG-330','UG-331','UG-332','UG-333','UG-334','UG-335','UG-336','UG-337','UG-401','UG-402','UG-403','UG-404','UG-405','UG-406','UG-407','UG-408','UG-409','UG-410','UG-411','UG-412','UG-413','UG-414','UG-415','UG-416','UG-417','UG-418','UG-419','UG-420','UG-421','UG-422','UG-423','UG-424','UG-425','UG-426','UG-427','UG-428','UG-429','UG-430','UG-431','UG-432','UG-433','UG-434','UG-435','UG-C','UG-E','UG-N','UG-W','UM-67','UM-71','UM-76','UM-79','UM-81','UM-84','UM-86','UM-89','UM-95','US-AK','US-AL','US-AR','US-AS','US-AZ','US-CA','US-CO','US-CT','US-DC','US-DE','US-FL','US-GA','US-GU','US-HI','US-IA','US-ID','US-IL','US-IN','US-KS','US-KY','US-LA','US-MA','US-MD','US-ME','US-MI','US-MN','US-MO','US-MP','US-MS','US-MT','US-NC','US-ND','US-NE','US-NH','US-NJ','US-NM','US-NV','US-NY','US-OH','US-OK','US-OR','US-PA','US-PR','US-RI','US-SC','US-SD','US-TN','US-TX','US-UM','US-UT','US-VA','US-VI','US-VT','US-WA','US-WI','US-WV','US-WY','UY-AR','UY-CA','UY-CL','UY-CO','UY-DU','UY-FD','UY-FS','UY-LA','UY-MA','UY-MO','UY-PA','UY-RN','UY-RO','UY-RV','UY-SA','UY-SJ','UY-SO','UY-TA','UY-TT','UZ-AN','UZ-BU','UZ-FA','UZ-JI','UZ-NG','UZ-NW','UZ-QA','UZ-QR','UZ-SA','UZ-SI','UZ-SU','UZ-TK','UZ-TO','UZ-XO','VC-01','VC-02','VC-03','VC-04','VC-05','VC-06','VE-A','VE-B','VE-C','VE-D','VE-E','VE-F','VE-G','VE-H','VE-I','VE-J','VE-K','VE-L','VE-M','VE-N','VE-O','VE-P','VE-R','VE-S','VE-T','VE-U','VE-V','VE-W','VE-X','VE-Y','VE-Z','VN-01','VN-02','VN-03','VN-04','VN-05','VN-06','VN-07','VN-09','VN-13','VN-14','VN-18','VN-20','VN-21','VN-22','VN-23','VN-24','VN-25','VN-26','VN-27','VN-28','VN-29','VN-30','VN-31','VN-32','VN-33','VN-34','VN-35','VN-36','VN-37','VN-39','VN-40','VN-41','VN-43','VN-44','VN-45','VN-46','VN-47','VN-49','VN-50','VN-51','VN-52','VN-53','VN-54','VN-55','VN-56','VN-57','VN-58','VN-59','VN-61','VN-63','VN-66','VN-67','VN-68','VN-69','VN-70','VN-71','VN-72','VN-73','VN-CT','VN-DN','VN-HN','VN-HP','VN-SG','VU-MAP','VU-PAM','VU-SAM','VU-SEE','VU-TAE','VU-TOB','WF-AL','WF-SG','WF-UV','WS-AA','WS-AL','WS-AT','WS-FA','WS-GE','WS-GI','WS-PA','WS-SA','WS-TU','WS-VF','WS-VS','YE-AB','YE-AD','YE-AM','YE-BA','YE-DA','YE-DH','YE-HD','YE-HJ','YE-HU','YE-IB','YE-JA','YE-LA','YE-MA','YE-MR','YE-MW','YE-RA','YE-SA','YE-SD','YE-SH','YE-SN','YE-SU','YE-TA','ZA-EC','ZA-FS','ZA-GP','ZA-KZN','ZA-LP','ZA-MP','ZA-NC','ZA-NW','ZA-WC','ZM-01','ZM-02','ZM-03','ZM-04','ZM-05','ZM-06','ZM-07','ZM-08','ZM-09','ZM-10','ZW-BU','ZW-HA','ZW-MA','ZW-MC','ZW-ME','ZW-MI','ZW-MN','ZW-MS','ZW-MV','ZW-MW']::text[]);
$function$;
revoke all on function private.catalog_subdivision_valid(text) from public, anon, authenticated, service_role;

create function private.catalog_language_valid(p_value text)
returns boolean language plpgsql immutable set search_path = '' as $function$
declare
  part text;
  seen_singletons text[] := '{}'::text[];
  seen_variants text[] := '{}'::text[];
  parts text[];
  in_extensions boolean := false;
begin
  if p_value is null or pg_catalog.char_length(p_value) > 80 or p_value !~
    '^([A-Za-z]{2,3}(-[A-Za-z]{3}){0,3}|[A-Za-z]{4}|[A-Za-z]{5,8})(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(-[0-9A-WY-Za-wy-z](-[A-Za-z0-9]{2,8})+)*(-x(-[A-Za-z0-9]{1,8})+)?$' then return false; end if;
  -- BCP 47 prohibits a repeated extension singleton or variant. Nothing
  -- after the private-use marker is interpreted as a standardized subtag.
  parts := pg_catalog.string_to_array(pg_catalog.lower(p_value), '-');
  -- Skip the primary language. Variants before the first extension and
  -- extension singleton keys have separate duplicate rules; extension
  -- payloads can legitimately repeat a core variant or language subtag.
  for part_index in 2..pg_catalog.cardinality(parts) loop
    part := parts[part_index];
    if part = 'x' then exit; end if;
    if pg_catalog.char_length(part) = 1 then
      if part = any(seen_singletons) then return false; end if;
      seen_singletons := pg_catalog.array_append(seen_singletons, part);
      in_extensions := true;
    elsif not in_extensions and (pg_catalog.char_length(part) >= 5 or part ~ '^[0-9][a-z0-9]{3}$') then
      if part = any(seen_variants) then return false; end if;
      seen_variants := pg_catalog.array_append(seen_variants, part);
    end if;
  end loop;
  return true;
end;
$function$;
revoke all on function private.catalog_language_valid(text) from public, anon, authenticated, service_role;

create function private.catalog_locale_valid(
  country text, subdivision text, postal_code text, language text, timezone text, locale_unknowns jsonb
) returns boolean language plpgsql stable set search_path = '' as $function$
declare
  field text;
  value text;
  reason text;
begin
  if country is not null and not private.catalog_country_valid(country) then return false; end if;
  if subdivision is not null and (country is null or not private.catalog_subdivision_valid(subdivision)
     or pg_catalog.split_part(subdivision, '-', 1) <> country) then return false; end if;
  if postal_code is not null and (pg_catalog.char_length(postal_code) not between 1 and 32
     or postal_code !~ '^[[:alnum:]][[:alnum:] -]*$') then return false; end if;
  if language is not null and not private.catalog_language_valid(language) then return false; end if;
  if timezone is not null and (pg_catalog.char_length(timezone) > 100
     or timezone !~ '^([A-Za-z_+-]+/)+[A-Za-z0-9_+/-]+$|^UTC$'
     or not exists (select 1 from pg_catalog.pg_timezone_names as tz where tz.name = timezone)) then return false; end if;
  if locale_unknowns is null or pg_catalog.jsonb_typeof(locale_unknowns) <> 'object' then return false; end if;
  for field, reason in select kv.key, kv.value from pg_catalog.jsonb_each_text(locale_unknowns) as kv loop
    if field not in ('country','subdivision','postal_code','language','timezone')
       or reason is null or reason not in ('not_published','not_applicable','unconfirmed','legacy_not_recorded') then return false; end if;
    value := case field when 'country' then country when 'subdivision' then subdivision
       when 'postal_code' then postal_code when 'language' then language when 'timezone' then timezone end;
    if value is not null then return false; end if;
  end loop;
  foreach field in array array['country','subdivision','postal_code','language','timezone'] loop
    value := case field when 'country' then country when 'subdivision' then subdivision
       when 'postal_code' then postal_code when 'language' then language when 'timezone' then timezone end;
    if value is null and not (locale_unknowns ? field) then return false; end if;
  end loop;
  return true;
end;
$function$;
revoke all on function private.catalog_locale_valid(text,text,text,text,text,jsonb) from public, anon, authenticated, service_role;

alter table private.catalog_organizations
  add column country text default 'US',
  add column subdivision text,
  add column postal_code text,
  add column language text,
  add column timezone text,
  add column locale_unknowns jsonb not null default '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
  add constraint catalog_organizations_locale_check check (
    private.catalog_locale_valid(country, subdivision, postal_code, language, timezone, locale_unknowns));
alter table private.catalog_edges
  add column country text default 'US',
  add column subdivision text,
  add column postal_code text,
  add column language text,
  add column timezone text,
  add column locale_unknowns jsonb not null default '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
  add constraint catalog_edges_locale_check check (
    private.catalog_locale_valid(country, subdivision, postal_code, language, timezone, locale_unknowns));
alter table private.catalog_subunits
  add column country text default 'US',
  add column subdivision text,
  add column postal_code text,
  add column language text,
  add column timezone text,
  add column locale_unknowns jsonb not null default '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
  add constraint catalog_subunits_locale_check check (
    private.catalog_locale_valid(country, subdivision, postal_code, language, timezone, locale_unknowns));
alter table private.catalog_seat_outlines
  add column country text default 'US',
  add column subdivision text,
  add column postal_code text,
  add column language text,
  add column timezone text,
  add column locale_unknowns jsonb not null default '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
  add constraint catalog_seat_outlines_locale_check check (
    private.catalog_locale_valid(country, subdivision, postal_code, language, timezone, locale_unknowns));
alter table private.catalog_contacts
  add column country text default 'US',
  add column subdivision text,
  add column postal_code text,
  add column language text,
  add column timezone text,
  add column locale_unknowns jsonb not null default '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
  add constraint catalog_contacts_locale_check check (
    private.catalog_locale_valid(country, subdivision, postal_code, language, timezone, locale_unknowns));
alter table private.catalog_documents
  add column country text default 'US',
  add column subdivision text,
  add column postal_code text,
  add column language text,
  add column timezone text,
  add column locale_unknowns jsonb not null default '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
  add constraint catalog_documents_locale_check check (
    private.catalog_locale_valid(country, subdivision, postal_code, language, timezone, locale_unknowns));
alter table private.catalog_research_facts
  add column country text default 'US',
  add column subdivision text,
  add column postal_code text,
  add column language text,
  add column timezone text,
  add column locale_unknowns jsonb not null default '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
  add constraint catalog_research_facts_locale_check check (
    private.catalog_locale_valid(country, subdivision, postal_code, language, timezone, locale_unknowns));
alter table private.catalog_research_categories
  add column country text default 'US',
  add column subdivision text,
  add column postal_code text,
  add column language text,
  add column timezone text,
  add column locale_unknowns jsonb not null default '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
  add constraint catalog_research_categories_locale_check check (
    private.catalog_locale_valid(country, subdivision, postal_code, language, timezone, locale_unknowns));
alter table private.catalog_coverage
  add column country text default 'US',
  add column subdivision text,
  add column postal_code text,
  add column language text,
  add column timezone text,
  add column locale_unknowns jsonb not null default '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
  add constraint catalog_coverage_locale_check check (
    private.catalog_locale_valid(country, subdivision, postal_code, language, timezone, locale_unknowns));
alter table private.catalog_organizations
  drop constraint catalog_organizations_state_check,
  drop constraint catalog_organizations_zip5_check,
  add constraint catalog_organizations_state_check check (
    (country is not distinct from 'US' and (state is null or state ~ '^[A-Z]{2}$')) or (state is null)),
  add constraint catalog_organizations_zip5_check check (
    (country is not distinct from 'US' and (zip5 is null or zip5 ~ '^[0-9]{5}$')) or (zip5 is null));
create index catalog_org_country_facets_idx on private.catalog_organizations (country, subdivision, family, tier)
  where retired_release_id is null and duplicate_of is null;

create table private.catalog_identifiers (
  identifier_key text primary key check (identifier_key ~ '^ri-[0-9a-f]{32}$'),
  catalog_key text not null references private.catalog_organizations(catalog_key),
  namespace text not null check (namespace ~ '^[a-z][a-z0-9_-]{1,39}$' and namespace <> 'olms'),
  identifier text not null check (identifier ~ '^[A-Za-z0-9][A-Za-z0-9./_-]{0,159}$'),
  source_url text not null check (source_url ~ '^https?://' and pg_catalog.char_length(source_url) <= 1000),
  as_of date not null,
  provenance pg_catalog.jsonb not null,
  constraint catalog_identifiers_provenance_complete check (
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  ),
  first_release_id uuid not null references private.catalog_releases(id),
  last_release_id uuid not null references private.catalog_releases(id),
  retired_release_id uuid references private.catalog_releases(id),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  unique(catalog_key, namespace, identifier)
);
alter table private.catalog_identifiers enable row level security;
alter table private.catalog_identifiers force row level security;
revoke all on table private.catalog_identifiers from public, anon, authenticated, service_role;
comment on table private.catalog_identifiers is 'Organization registry evidence only; foreign identifiers are never OLMS numbers. Owner-only release path, no client policies.';

alter table private.catalog_staging drop constraint catalog_staging_table_name_check;
alter table private.catalog_staging add constraint catalog_staging_table_name_check
  check (table_name in ('organizations','edges','subunits','seat_outlines','contacts','documents',
    'document_subunits','research_facts','research_categories','identifiers'));

create or replace function private.catalog_activate_release(p_label text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_id uuid;
  target_status text;
  target_loaded_at timestamptz;
  target_verified_at timestamptz;
  target_verified_sha256 text;
  staged_sha256 text;
  allow_retire bigint;
  research_loaded_over uuid;
  previous_id uuid;
  staged_organizations bigint;
  live_organizations bigint;
  retiring_organizations bigint;
  live_subunits bigint;
  retiring_subunits bigint;
  mismatched_tables text[];
  diff jsonb;
begin
  if p_label is null or p_label !~ '^[0-9]{8}-[0-9]{2}$' then
    raise exception 'invalid catalog release label' using errcode = '22023';
  end if;

  -- One activation at a time. Only private.catalog_* rows are involved.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('union-catalog-activation', 509));

  select r.id, r.status, r.loaded_at, r.verified_at, r.verified_sha256, (r.counts ->> 'allowRetire')::bigint
    into target_id, target_status, target_loaded_at, target_verified_at, target_verified_sha256, allow_retire
    from private.catalog_releases as r
   where r.label = p_label
     for update;
  -- A staged release, or a retired one whose staging rows were kept for a
  -- rollback. Never the active release and never a failed one.
  if target_id is null or target_status not in ('staged', 'retired') then
    raise exception 'catalog release is not staged' using errcode = '22023';
  end if;
  -- catalog:verify stamps verified_at when the staged rows match the
  -- artifact; a later load clears the stamp by moving loaded_at past it, a
  -- failed verify clears it, and retiring a release clears it, so a rollback
  -- is verified again against the current exclusion list and privacy gate.
  if target_verified_at is null or target_verified_at < target_loaded_at then
    raise exception 'catalog release is not verified; run catalog:verify first' using errcode = '22023';
  end if;
  select pg_catalog.count(*)
    into staged_organizations
    from private.catalog_staging as s
   where s.release_id = target_id
     and s.table_name = 'organizations';
  if staged_organizations = 0 then
    raise exception 'catalog release has no staged rows; load it again' using errcode = '22023';
  end if;
  -- The staged rows must be exactly the ones catalog:verify matched: the
  -- digest (sha256 over every staged row's table, key, content hash and a
  -- sha256 of its content, in key order) is recomputed here and compared
  -- with the one verify stored. scripts/load-union-catalog.mjs
  -- (STAGING_DIGEST_SQL) computes the same expression.
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(
           s.table_name || ' ' || s.row_key || ' ' || s.content_sha256 || ' '
             || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.content::text, 'UTF8')), 'hex'),
           pg_catalog.chr(10) order by s.table_name, s.row_key), ''), 'UTF8')), 'hex')
    into staged_sha256
    from private.catalog_staging as s
   where s.release_id = target_id;
  if target_verified_sha256 is null or staged_sha256 is distinct from target_verified_sha256 then
    raise exception 'catalog release staged rows changed after catalog:verify; run catalog:verify again' using errcode = '22023';
  end if;

  -- A research release carries its base's content rows unchanged and was
  -- checked at load against the live rows of the release then active
  -- (catalog:load records its id in research_loaded_over). It may
  -- replace only that release: if another release was activated since, its
  -- corrections or research rows would be overwritten or retired unchecked.
  -- A retired target is a deliberate rollback to a snapshot that was live,
  -- verified again, under the withdrawal guard below; it is not rechecked.
  select r.research_loaded_over into research_loaded_over from private.catalog_releases as r where r.id = target_id;
  if target_status = 'staged'
     and research_loaded_over is not null
     and research_loaded_over is distinct from (
       select r.id from private.catalog_releases as r where r.status = 'active') then
    raise exception 'catalog research release was loaded over a release that is no longer active; load it again' using errcode = '22023';
  end if;

  -- The withdrawal guard (spec section 2.6), enforced where rows actually
  -- retire: more than 3% of live organizations or 10% of live sub-units may
  -- retire only under the ceiling the operator recorded with --allow-retire.
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where not exists (
           select 1 from private.catalog_staging as s
            where s.release_id = target_id and s.table_name = 'organizations' and s.row_key = o.catalog_key))
    into live_organizations, retiring_organizations
    from private.catalog_organizations as o
   where o.retired_release_id is null;
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where not exists (
           select 1 from private.catalog_staging as s
            where s.release_id = target_id and s.table_name = 'subunits' and s.row_key = u.subunit_key))
    into live_subunits, retiring_subunits
    from private.catalog_subunits as u
   where u.retired_release_id is null;
  if (allow_retire is not null and retiring_organizations + retiring_subunits > allow_retire)
     or (allow_retire is null
         and (retiring_organizations > live_organizations * 0.03 or retiring_subunits > live_subunits * 0.1)) then
    raise exception 'withdrawal guard: % of % live organizations and % of % live sub-units would retire; re-run activate with --allow-retire %',
      retiring_organizations, live_organizations, retiring_subunits, live_subunits, retiring_organizations + retiring_subunits
      using errcode = '22023';
  end if;

  -- Apply the staged set: insert new rows, update rows whose content changed
  -- or that were retired, leave unchanged live rows alone (first_release_id
  -- is never updated), then retire every live row the release does not carry.
  -- organizations
  insert into private.catalog_organizations as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_organizations,
      '{"country":"US","subdivision":null,"postal_code":null,"language":null,"timezone":null,"locale_unknowns":{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}}'::jsonb || s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'organizations'
  on conflict (catalog_key) do update
     set olms_file_number = excluded.olms_file_number,
         union_org_id = excluded.union_org_id,
         origin = excluded.origin,
         name = excluded.name,
         aka = excluded.aka,
         family = excluded.family,
         designation = excluded.designation,
         local_number = excluded.local_number,
         tier = excluded.tier,
         org_type_label = excluded.org_type_label,
         sector = excluded.sector,
         industries = excluded.industries,
         occupations = excluded.occupations,
         trades = excluded.trades,
         city = excluded.city,
         state = excluded.state,
         zip5 = excluded.zip5,
         census_region = excluded.census_region,
         census_division = excluded.census_division,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         geo_precision = excluded.geo_precision,
         website = excluded.website,
         members_reported = excluded.members_reported,
         members_fiscal_year = excluded.members_fiscal_year,
         structure_note = excluded.structure_note,
         election_term_years = excluded.election_term_years,
         next_election_on = excluded.next_election_on,
         bylaws_url = excluded.bylaws_url,
         confidence = excluded.confidence,
         researched_on = excluded.researched_on,
         source_urls = excluded.source_urls,
         duplicate_of = excluded.duplicate_of,
         search_text = excluded.search_text,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         country = excluded.country,
         subdivision = excluded.subdivision,
         postal_code = excluded.postal_code,
         language = excluded.language,
         timezone = excluded.timezone,
         locale_unknowns = excluded.locale_unknowns,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;


  -- Foreign registry identifiers have the same staged/hash/retirement lifecycle.
  insert into private.catalog_identifiers as t
  select r.* from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(null::private.catalog_identifiers,
      s.content || pg_catalog.jsonb_build_object('first_release_id', target_id, 'last_release_id', target_id,
        'retired_release_id', null, 'content_sha256', s.content_sha256)) as r
   where s.release_id = target_id and s.table_name = 'identifiers'
  on conflict (identifier_key) do update set
    catalog_key = excluded.catalog_key, namespace = excluded.namespace, identifier = excluded.identifier,
    source_url = excluded.source_url, as_of = excluded.as_of, provenance = excluded.provenance,
    last_release_id = excluded.last_release_id, retired_release_id = null, content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256 or t.retired_release_id is not null;
  update private.catalog_identifiers as t set retired_release_id = target_id
   where t.retired_release_id is null and not exists (
     select 1 from private.catalog_staging as s where s.release_id = target_id
       and s.table_name = 'identifiers' and s.row_key = t.identifier_key);

  -- edges
  insert into private.catalog_edges as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_edges,
      '{"country":"US","subdivision":null,"postal_code":null,"language":null,"timezone":null,"locale_unknowns":{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}}'::jsonb || s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'edges'
  on conflict (edge_key) do update
     set child_key = excluded.child_key,
         parent_key = excluded.parent_key,
         parent_label = excluded.parent_label,
         edge_kind = excluded.edge_kind,
         certainty = excluded.certainty,
         source_url = excluded.source_url,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         country = excluded.country,
         subdivision = excluded.subdivision,
         postal_code = excluded.postal_code,
         language = excluded.language,
         timezone = excluded.timezone,
         locale_unknowns = excluded.locale_unknowns,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- subunits
  insert into private.catalog_subunits as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_subunits,
      '{"country":"US","subdivision":null,"postal_code":null,"language":null,"timezone":null,"locale_unknowns":{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}}'::jsonb || s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'subunits'
  on conflict (subunit_key) do update
     set catalog_key = excluded.catalog_key,
         parent_subunit_key = excluded.parent_subunit_key,
         kind = excluded.kind,
         kind_label = excluded.kind_label,
         name = excluded.name,
         location = excluded.location,
         employer = excluded.employer,
         members = excluded.members,
         members_source = excluded.members_source,
         density_note = excluded.density_note,
         website = excluded.website,
         election_note = excluded.election_note,
         structure_note = excluded.structure_note,
         confidence = excluded.confidence,
         source_url = excluded.source_url,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         country = excluded.country,
         subdivision = excluded.subdivision,
         postal_code = excluded.postal_code,
         language = excluded.language,
         timezone = excluded.timezone,
         locale_unknowns = excluded.locale_unknowns,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- seat_outlines
  insert into private.catalog_seat_outlines as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_seat_outlines,
      '{"country":"US","subdivision":null,"postal_code":null,"language":null,"timezone":null,"locale_unknowns":{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}}'::jsonb || s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'seat_outlines'
  on conflict (outline_key) do update
     set catalog_key = excluded.catalog_key,
         subunit_key = excluded.subunit_key,
         seat_class = excluded.seat_class,
         title = excluded.title,
         listed = excluded.listed,
         vacant = excluded.vacant,
         source_url = excluded.source_url,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         country = excluded.country,
         subdivision = excluded.subdivision,
         postal_code = excluded.postal_code,
         language = excluded.language,
         timezone = excluded.timezone,
         locale_unknowns = excluded.locale_unknowns,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- contacts
  insert into private.catalog_contacts as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_contacts,
      '{"country":"US","subdivision":null,"postal_code":null,"language":null,"timezone":null,"locale_unknowns":{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}}'::jsonb || s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'contacts'
  on conflict (contact_key) do update
     set catalog_key = excluded.catalog_key,
         contact_kind = excluded.contact_kind,
         value = excluded.value,
         label = excluded.label,
         basis = excluded.basis,
         source_url = excluded.source_url,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         country = excluded.country,
         subdivision = excluded.subdivision,
         postal_code = excluded.postal_code,
         language = excluded.language,
         timezone = excluded.timezone,
         locale_unknowns = excluded.locale_unknowns,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- documents
  insert into private.catalog_documents as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_documents,
      '{"country":"US","subdivision":null,"postal_code":null,"language":null,"timezone":null,"locale_unknowns":{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}}'::jsonb || s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'documents'
  on conflict (document_key) do update
     set catalog_key = excluded.catalog_key,
         doc_kind = excluded.doc_kind,
         title = excluded.title,
         title_derived = excluded.title_derived,
         url = excluded.url,
         url_host = excluded.url_host,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         country = excluded.country,
         subdivision = excluded.subdivision,
         postal_code = excluded.postal_code,
         language = excluded.language,
         timezone = excluded.timezone,
         locale_unknowns = excluded.locale_unknowns,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- document_subunits
  insert into private.catalog_document_subunits as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_document_subunits,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'document_subunits'
  on conflict (document_key, subunit_key) do update
     set last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- research_facts
  insert into private.catalog_research_facts as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_research_facts,
      '{"country":"US","subdivision":null,"postal_code":null,"language":null,"timezone":null,"locale_unknowns":{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}}'::jsonb || s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'research_facts'
  on conflict (fact_key) do update
     set evidence_tier = excluded.evidence_tier,
         binding = excluded.binding,
         catalog_key = excluded.catalog_key,
         publisher_candidates = excluded.publisher_candidates,
         fact_kind = excluded.fact_kind,
         title = excluded.title,
         url = excluded.url,
         url_host = excluded.url_host,
         as_of = excluded.as_of,
         unresolved = excluded.unresolved,
         source_sha256 = excluded.source_sha256,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         country = excluded.country,
         subdivision = excluded.subdivision,
         postal_code = excluded.postal_code,
         language = excluded.language,
         timezone = excluded.timezone,
         locale_unknowns = excluded.locale_unknowns,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- research_categories
  insert into private.catalog_research_categories as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_research_categories,
      '{"country":"US","subdivision":null,"postal_code":null,"language":null,"timezone":null,"locale_unknowns":{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}}'::jsonb || s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'research_categories'
  on conflict (category_key) do update
     set catalog_key = excluded.catalog_key,
         evidence_tier = excluded.evidence_tier,
         category = excluded.category,
         outcome = excluded.outcome,
         gate_contract = excluded.gate_contract,
         evaluated_on = excluded.evaluated_on,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         country = excluded.country,
         subdivision = excluded.subdivision,
         postal_code = excluded.postal_code,
         language = excluded.language,
         timezone = excluded.timezone,
         locale_unknowns = excluded.locale_unknowns,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;


  update private.catalog_organizations as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'organizations' and s.row_key = t.catalog_key);

  update private.catalog_edges as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'edges' and s.row_key = t.edge_key);

  update private.catalog_subunits as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'subunits' and s.row_key = t.subunit_key);

  update private.catalog_seat_outlines as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'seat_outlines' and s.row_key = t.outline_key);

  update private.catalog_contacts as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'contacts' and s.row_key = t.contact_key);

  update private.catalog_documents as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'documents' and s.row_key = t.document_key);

  update private.catalog_document_subunits as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'document_subunits' and s.row_key = t.document_key || '|' || t.subunit_key);

  -- A release without research tables retires every live research row: a
  -- release is a complete snapshot of everything it carries.
  update private.catalog_research_facts as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'research_facts' and s.row_key = t.fact_key);

  update private.catalog_research_categories as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'research_categories' and s.row_key = t.category_key);

  select r.id
    into previous_id
    from private.catalog_releases as r
   where r.status = 'active';

  -- The retired release keeps its staging rows for a rollback, but not its
  -- verify stamp: activating it again needs a fresh catalog:verify.
  update private.catalog_releases as r
     set status = 'retired',
         verified_at = null,
         verified_sha256 = null
   where r.status = 'active';

  update private.catalog_releases as r
     set status = 'active',
         activated_at = pg_catalog.now()
   where r.id = target_id;

  delete from private.catalog_coverage as cov
   where cov.catalog_key is not null;

  insert into private.catalog_coverage (
    catalog_key, release_id, subunits, subunits_with_members, seat_outlines, documents, checklist, band, last_researched, country, subdivision, postal_code, language, timezone, locale_unknowns
  )
  select o.catalog_key,
         target_id,
         coalesce(sub.total, 0),
         coalesce(sub.with_members, 0),
         coalesce(seat.total, 0),
         pg_catalog.jsonb_build_object(
           'contract', coalesce(doc.contracts, 0),
           'bylaws', coalesce(doc.bylaws, 0),
           'form', coalesce(doc.forms, 0),
           'newsletter', coalesce(doc.newsletters, 0),
           'handbook', coalesce(doc.handbooks, 0),
           'other', coalesce(doc.others, 0)
         ),
         pg_catalog.jsonb_build_object(
           'website', o.website is not null,
           'publicContact', coalesce(contact.public_contacts, 0) > 0,
           'structure', coalesce(sub.total, 0) > 0,
           'seats', coalesce(seat.total, 0) > 0,
           'governingDocument', o.bylaws_url is not null or coalesce(doc.bylaws, 0) > 0,
           'contract', coalesce(doc.contracts, 0) > 0,
           'electionCadence', o.election_term_years is not null or o.next_election_on is not null,
           'hierarchy', coalesce(edge.total, 0) > 0
         ),
         case
           when coalesce(sub.total, 0) > 0 and coalesce(doc.total, 0) > 0 and o.members_reported is not null then 'deep'
           when coalesce(sub.total, 0) > 0 or coalesce(seat.total, 0) > 0 then 'structured'
           else 'basic'
         end,
         o.researched_on, o.country, o.subdivision, o.postal_code, o.language, o.timezone, o.locale_unknowns
    from private.catalog_organizations as o
    left join (
      select s.catalog_key, pg_catalog.count(*) as total,
             pg_catalog.count(*) filter (where s.members is not null) as with_members
        from private.catalog_subunits as s
       where s.retired_release_id is null
       group by s.catalog_key
    ) as sub on sub.catalog_key = o.catalog_key
    left join (
      select so.catalog_key, pg_catalog.count(*) as total
        from private.catalog_seat_outlines as so
       where so.retired_release_id is null
       group by so.catalog_key
    ) as seat on seat.catalog_key = o.catalog_key
    left join (
      select d.catalog_key, pg_catalog.count(*) as total,
             pg_catalog.count(*) filter (where d.doc_kind = 'contract') as contracts,
             pg_catalog.count(*) filter (where d.doc_kind = 'bylaws') as bylaws,
             pg_catalog.count(*) filter (where d.doc_kind = 'form') as forms,
             pg_catalog.count(*) filter (where d.doc_kind = 'newsletter') as newsletters,
             pg_catalog.count(*) filter (where d.doc_kind = 'handbook') as handbooks,
             pg_catalog.count(*) filter (where d.doc_kind = 'other') as others
        from private.catalog_documents as d
       where d.retired_release_id is null
       group by d.catalog_key
    ) as doc on doc.catalog_key = o.catalog_key
    left join (
      select c.catalog_key, pg_catalog.count(*) filter (where c.contact_kind <> 'website') as public_contacts
        from private.catalog_contacts as c
       where c.retired_release_id is null
       group by c.catalog_key
    ) as contact on contact.catalog_key = o.catalog_key
    left join (
      select ends.catalog_key, pg_catalog.count(*) as total
        from (
          select e.child_key as catalog_key from private.catalog_edges as e where e.retired_release_id is null
          union all
          select e.parent_key from private.catalog_edges as e where e.retired_release_id is null and e.parent_key is not null
        ) as ends
       group by ends.catalog_key
    ) as edge on edge.catalog_key = o.catalog_key
   where o.retired_release_id is null
     and o.duplicate_of is null;


  -- The live, non-retired row set must now be exactly the staged set.
  select pg_catalog.array_agg(live.table_name order by live.table_name)
    into mismatched_tables
    from (
      select 'organizations' as table_name, pg_catalog.count(*) as live_rows
        from private.catalog_organizations as t where t.retired_release_id is null
      union all
      select 'edges', pg_catalog.count(*) from private.catalog_edges as t where t.retired_release_id is null
      union all
      select 'subunits', pg_catalog.count(*) from private.catalog_subunits as t where t.retired_release_id is null
      union all
      select 'seat_outlines', pg_catalog.count(*) from private.catalog_seat_outlines as t where t.retired_release_id is null
      union all
      select 'contacts', pg_catalog.count(*) from private.catalog_contacts as t where t.retired_release_id is null
      union all
      select 'documents', pg_catalog.count(*) from private.catalog_documents as t where t.retired_release_id is null
      union all
      select 'document_subunits', pg_catalog.count(*) from private.catalog_document_subunits as t where t.retired_release_id is null
      union all
      select 'research_facts', pg_catalog.count(*) from private.catalog_research_facts as t where t.retired_release_id is null
      union all
      select 'identifiers', pg_catalog.count(*) from private.catalog_identifiers as t where t.retired_release_id is null
      union all
      select 'research_categories', pg_catalog.count(*) from private.catalog_research_categories as t where t.retired_release_id is null
    ) as live
    left join (
      select s.table_name, pg_catalog.count(*) as staged_rows
        from private.catalog_staging as s
       where s.release_id = target_id
       group by s.table_name
    ) as staged on staged.table_name = live.table_name
   where live.live_rows <> coalesce(staged.staged_rows, 0);
  if mismatched_tables is not null then
    raise exception 'catalog activation left % out of step with the staged release', mismatched_tables;
  end if;

  -- Counts only: what this release added, retired and changed.
  diff := pg_catalog.jsonb_build_object(
    'organizationsAdded', (select pg_catalog.count(*) from private.catalog_organizations as o
                            where o.first_release_id = target_id and o.retired_release_id is null),
    'organizationsRetired', (select pg_catalog.count(*) from private.catalog_organizations as o
                              where o.retired_release_id = target_id),
    'organizationsChanged', (select pg_catalog.count(*) from private.catalog_organizations as o
                              where o.last_release_id = target_id and o.first_release_id <> target_id
                                and o.retired_release_id is null),
    'subunitsAdded', (select pg_catalog.count(*) from private.catalog_subunits as s
                       where s.first_release_id = target_id and s.retired_release_id is null),
    'subunitsRetired', (select pg_catalog.count(*) from private.catalog_subunits as s
                         where s.retired_release_id = target_id)
  );
  -- Research counts appear only when research rows were involved, so the
  -- diff of a release without research tables keeps its earlier shape.
  if exists (select 1 from private.catalog_staging as s
              where s.release_id = target_id and s.table_name in ('research_facts', 'research_categories'))
     or exists (select 1 from private.catalog_research_facts as f where f.retired_release_id = target_id)
     or exists (select 1 from private.catalog_research_categories as c where c.retired_release_id = target_id) then
    diff := diff || pg_catalog.jsonb_build_object(
      'researchFactsAdded', (select pg_catalog.count(*) from private.catalog_research_facts as f
                              where f.first_release_id = target_id and f.retired_release_id is null),
      'researchFactsRetired', (select pg_catalog.count(*) from private.catalog_research_facts as f
                                where f.retired_release_id = target_id),
      'researchCategoriesAdded', (select pg_catalog.count(*) from private.catalog_research_categories as c
                                   where c.first_release_id = target_id and c.retired_release_id is null),
      'researchCategoriesRetired', (select pg_catalog.count(*) from private.catalog_research_categories as c
                                     where c.retired_release_id = target_id)
    );
  end if;

  update private.catalog_releases as r
     set activation_diff = diff
   where r.id = target_id;

  -- Keep the staging rows of this release and of the one it retired (a
  -- rollback re-applies them); every other release must be loaded again.
  delete from private.catalog_staging as s
   where s.release_id <> target_id
     and s.release_id is distinct from previous_id;

  -- REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110: the registry
  -- websites linked to the catalog are judged again now that its documents
  -- are final. Unlike the rest of this function, this call also writes
  -- outside the catalog: it updates public.union_orgs.website.
  perform private.catalog_refresh_registry_websites();

  return diff;
end;
$function$;
revoke all on function private.catalog_activate_release(text) from public, anon, authenticated, service_role;

create or replace function public.search_union_catalog_by_country(
  p_query text,
  p_state text,
  p_family text,
  p_tier text,
  p_page integer,
  p_country text,
  p_subdivision text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  query_text text := nullif(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), '');
  state_filter text := nullif(p_state, '');
  family_filter text := nullif(pg_catalog.btrim(coalesce(p_family, '')), '');
  tier_filter text := nullif(p_tier, '');
  country_filter text := nullif(p_country, '');
  subdivision_filter text := nullif(p_subdivision, '');
  registry_level text;
  number_match text[];
  local_number_filter text;
  text_part text;
  pattern text;
  full_pattern text;
  catalog_live boolean;
  match_count bigint;
  page_rows jsonb;
  -- A member is any Union Ground account in its own session.
  caller_is_member constant boolean := auth.uid() is not null;
begin
  if p_query ~ '[[:cntrl:]]' then
    raise exception 'invalid catalog search query' using errcode = '22023';
  end if;
  if query_text is not null and pg_catalog.char_length(query_text) not between 2 and 80 then
    raise exception 'catalog search query must be 2 to 80 characters' using errcode = '22023';
  end if;
  if state_filter is not null and state_filter !~ '^[A-Z]{2}$' then
    raise exception 'invalid catalog search state' using errcode = '22023';
  end if;
  if country_filter is not null and not private.catalog_country_valid(country_filter) then
    raise exception 'invalid catalog search country' using errcode = '22023';
  end if;
  if subdivision_filter is not null and (country_filter is null or
     not private.catalog_subdivision_valid(subdivision_filter) or pg_catalog.split_part(subdivision_filter, '-', 1) <> country_filter) then
    raise exception 'invalid catalog search subdivision' using errcode = '22023';
  end if;
  if query_text is null and state_filter is null and country_filter is null then
    raise exception 'catalog search needs a query, state or country' using errcode = '22023';
  end if;
  if p_family ~ '[[:cntrl:]]' or pg_catalog.char_length(family_filter) > 40 then
    raise exception 'invalid catalog search family' using errcode = '22023';
  end if;
  if tier_filter is not null and tier_filter not in ('national', 'regional', 'state', 'local', 'sub_local') then
    raise exception 'invalid catalog search tier' using errcode = '22023';
  end if;
  if p_page is null or p_page not between 1 and 40 then
    raise exception 'invalid catalog search page' using errcode = '22023';
  end if;

  registry_level := case tier_filter
    when 'national' then 'national'
    when 'regional' then 'intermediate'
    when 'state' then 'intermediate'
    when 'local' then 'local'
    when 'sub_local' then 'local'
  end;

  -- The Phase 1 reading of a query: "Local 600", "lu 12 boston" or a bare
  -- number names a local number; the remaining text (two characters or more)
  -- matches a name, a city or the catalog search text.
  if query_text is not null then
    number_match := pg_catalog.regexp_match(query_text, '^#?([0-9]{1,7})$');
    if number_match is not null then
      local_number_filter := (number_match[1])::integer::text;
    else
      number_match := pg_catalog.regexp_match(query_text,
        '(^|\s)(local|lu|lodge|branch|br|chapter|ch|division|div)\s*#?\s*([0-9]{1,7})(?=\s|$)', 'i');
      if number_match is not null then
        local_number_filter := (number_match[3])::integer::text;
        text_part := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(query_text,
          '(^|\s)(local|lu|lodge|branch|br|chapter|ch|division|div)\s*#?\s*([0-9]{1,7})(?=\s|$)', ' ', 'i'), '\s+', ' ', 'g'));
        full_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(query_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
      else
        text_part := query_text;
      end if;
    end if;
    if pg_catalog.char_length(text_part) >= 2 then
      pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(text_part, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    end if;
  end if;

  catalog_live := exists (select 1 from private.catalog_releases as r where r.status = 'active');

  with matches as (
    select 0 as source_rank, o.name as sort_name, o.catalog_key as sort_key, null::text as registry_parent,
      pg_catalog.jsonb_build_object(
        'key', o.catalog_key,
        'registryOnly', false,
        'name', o.name,
        'family', o.family,
        'designation', o.designation,
        'localNumber', o.local_number,
        'tier', o.tier,
        'level', case o.tier when 'national' then 'national' when 'regional' then 'intermediate'
                   when 'state' then 'intermediate' else 'local' end,
        'city', o.city,
        'state', o.state,
        'country', o.country,
        'subdivision', o.subdivision,
        'postalCode', o.postal_code, 'language', o.language, 'timezone', o.timezone, 'localeUnknowns', o.locale_unknowns,
        'website', o.website,
        'membersReported', o.members_reported,
        'membersFiscalYear', o.members_fiscal_year,
        'registryId', o.union_org_id
      ) as payload
      from private.catalog_organizations as o
     where catalog_live
       and o.retired_release_id is null
       and o.duplicate_of is null
       and private.catalog_registry_identity_visible(o.union_org_id)
       and (local_number_filter is null or o.local_number = local_number_filter
            or (full_pattern is not null and o.name ilike full_pattern escape '\'))
       and (pattern is null or o.name ilike pattern escape '\' or o.city ilike pattern escape '\'
            or o.search_text ilike pattern escape '\')
       and (country_filter is null or o.country = country_filter)
       and (subdivision_filter is null or o.subdivision = subdivision_filter)
       and (state_filter is null or o.state = state_filter)
       and (family_filter is null or o.family = family_filter)
       and (tier_filter is null or o.tier = tier_filter)
    union all
    select 1 as source_rank, u.name as sort_name, u.id as sort_key, u.parent_name as registry_parent,
      pg_catalog.jsonb_build_object(
        'key', u.id,
        'registryOnly', true,
        'name', u.name,
        'family', u.affiliation,
        'designation', u.designation,
        'localNumber', u.local_number,
        'tier', null,
        'level', u.level,
        'city', u.city,
        'state', u.state,
        'country', 'US', 'subdivision', null, 'postalCode', null, 'language', null, 'timezone', null,
        'localeUnknowns', '{"subdivision":"legacy_not_recorded","postal_code":"legacy_not_recorded","language":"legacy_not_recorded","timezone":"legacy_not_recorded"}'::jsonb,
        'website', u.website,
        'membersReported', u.members_latest,
        'membersFiscalYear', u.members_latest_year,
        'registryId', u.id
      ) as payload
      from public.union_orgs as u
     where not u.is_fictional
       and (local_number_filter is null or u.local_number = local_number_filter
            or (full_pattern is not null and u.name ilike full_pattern escape '\'))
       and (pattern is null or u.name ilike pattern escape '\' or u.city ilike pattern escape '\'
            or u.affiliation ilike pattern escape '\')
       and (country_filter is null or country_filter = 'US')
       and subdivision_filter is null
       and (state_filter is null or u.state = state_filter)
       and (family_filter is null or u.affiliation = family_filter)
       and (registry_level is null or u.level = registry_level)
       and (not catalog_live or not exists (
             select 1 from private.catalog_organizations as c
              where c.olms_file_number = u.olms_file_number and c.retired_release_id is null
                and private.catalog_registry_identity_visible(c.union_org_id)))
  )
  select
    (select pg_catalog.count(*) from (select 1 from matches limit 1001) as capped),
    coalesce((
      select pg_catalog.jsonb_agg(
               -- The "Part of" line. A catalog row: the highest-ranked live
               -- edge that still names something visible, that is its
               -- visible parent (an edge to a retired or duplicate
               -- organization is skipped, as in the profile) or else its
               -- scrubbed label (a label-only edge whose label is scrubbed is
               -- skipped, so a lower-ranked visible parent wins); null when
               -- no edge qualifies. A registry row: the registry's own
               -- parent name, scrubbed the same way.
               page.payload || pg_catalog.jsonb_build_object('parentName', case when page.source_rank = 0 then (
                 select coalesce(parent.name, private.catalog_scrub_text(e.parent_label))
                   from private.catalog_edges as e
                   left join private.catalog_organizations as parent
                     on parent.catalog_key = e.parent_key
                    and parent.retired_release_id is null
                    and parent.duplicate_of is null
                    and private.catalog_registry_identity_visible(parent.union_org_id)
                  where e.child_key = page.sort_key
                    and e.retired_release_id is null
                    and (e.parent_key is null or parent.catalog_key is not null)
                    and coalesce(parent.name, private.catalog_scrub_text(e.parent_label)) is not null
                  order by case e.edge_kind when 'olms_parent' then 0 when 'parent_body' then 1 else 2 end, e.edge_key
                  limit 1
               ) else private.catalog_scrub_text(page.registry_parent) end)
               order by page.source_rank, page.sort_name, page.sort_key)
        from (
          select m.source_rank, m.sort_name, m.sort_key, m.registry_parent, m.payload
            from matches as m
           order by m.source_rank, m.sort_name, m.sort_key
           limit 25 offset (p_page - 1) * 25
        ) as page
    ), '[]'::jsonb)
    into match_count, page_rows;

  -- Document links are for members: without an account every string of each
  -- row (its website and its labels) goes through the rule as text, a catalog
  -- row's against its own organization's withheld destinations and a registry
  -- row's against those of the catalog organizations linked to it.
  if not caller_is_member then
    select coalesce(pg_catalog.jsonb_agg(private.catalog_public_json(r.value,
             case when (r.value ->> 'registryOnly')::boolean
                  then private.registry_withheld_destinations(r.value ->> 'key',
                         (select u.olms_file_number from public.union_orgs as u where u.id = r.value ->> 'key'))
                  else private.catalog_withheld_destinations(r.value ->> 'key') end) order by r.n), '[]'::jsonb)
      into page_rows
      from pg_catalog.jsonb_array_elements(page_rows) with ordinality as r(value, n);
  end if;

  return pg_catalog.jsonb_build_object(
    'rows', page_rows,
    'page', p_page,
    'pageSize', 25,
    'total', least(match_count, 1000),
    'totalCapped', match_count > 1000,
    'hasNext', p_page < 40 and p_page * 25 < least(match_count, 1000)
  );
end;
$function$;
revoke all on function public.search_union_catalog_by_country(text,text,text,text,integer,text,text) from public, anon, authenticated, service_role;
grant execute on function public.search_union_catalog_by_country(text,text,text,text,integer,text,text) to anon, authenticated, service_role;
create or replace function public.search_union_catalog(p_query text, p_state text, p_family text, p_tier text, p_page integer)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select public.search_union_catalog_by_country(p_query,p_state,p_family,p_tier,p_page,null,null);
$function$;
revoke all on function public.search_union_catalog(text,text,text,text,integer) from public, anon, authenticated, service_role;
grant execute on function public.search_union_catalog(text,text,text,text,integer) to anon, authenticated, service_role;

create or replace function public.get_union_catalog_profile_by_country(p_key text, p_country text, p_subdivision text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  organization jsonb;
  answer jsonb;
  -- A member is any Union Ground account in its own session.
  caller_is_member constant boolean := auth.uid() is not null;
  withheld text[] := '{}'::text[];
begin
  if p_country is not null and not private.catalog_country_valid(p_country) then
    raise exception 'invalid catalog search country' using errcode = '22023';
  end if;
  if p_subdivision is not null and (p_country is null or
     not private.catalog_subdivision_valid(p_subdivision) or pg_catalog.split_part(p_subdivision, '-', 1) <> p_country) then
    raise exception 'invalid catalog search subdivision' using errcode = '22023';
  end if;
  if p_key is null or p_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'invalid catalog key' using errcode = '22023';
  end if;

  -- Document links are for members. Without an account, every link this
  -- organization's documents and bylaws carry is withheld, and so is any
  -- other link to one of those destinations under any spelling, except an
  -- address this profile returns as a website that reads as a home page (no
  -- document word anywhere in its path).
  if not caller_is_member then
    withheld := private.catalog_withheld_destinations(p_key);
  end if;

  -- Unknown, retired and duplicate keys, and every key while no release is
  -- active, get the same answer.
  select pg_catalog.jsonb_build_object(
      'country', o.country, 'subdivision', o.subdivision, 'postalCode', o.postal_code,
      'language', o.language, 'timezone', o.timezone, 'localeUnknowns', o.locale_unknowns,
      'key', o.catalog_key,
      'olmsFileNumber', o.olms_file_number,
      'registryId', o.union_org_id,
      'origin', o.origin,
      'name', o.name,
      'aka', o.aka,
      'family', o.family,
      'designation', o.designation,
      'localNumber', o.local_number,
      'tier', o.tier,
      'level', case o.tier when 'national' then 'national' when 'regional' then 'intermediate'
                 when 'state' then 'intermediate' else 'local' end,
      'orgTypeLabel', o.org_type_label,
      'sector', o.sector,
      'industries', o.industries,
      'occupations', o.occupations,
      'trades', o.trades,
      'city', o.city,
      'state', o.state,
      'zip5', o.zip5,
      'censusRegion', o.census_region,
      'censusDivision', o.census_division,
      'latitude', o.latitude,
      'longitude', o.longitude,
      'geoPrecision', o.geo_precision,
      'website', case when caller_is_member then o.website else private.catalog_public_citation(o.website, withheld) end,
      'membersReported', o.members_reported,
      'membersFiscalYear', o.members_fiscal_year,
      'structureNote', private.catalog_scrub_text(o.structure_note),
      'electionTermYears', o.election_term_years,
      'nextElectionOn', o.next_election_on,
      'bylawsUrl', case when caller_is_member then o.bylaws_url end,
      'confidence', o.confidence,
      'researchedOn', o.researched_on,
      'sourceUrls', case when caller_is_member then pg_catalog.to_jsonb(o.source_urls) else (
        select coalesce(pg_catalog.jsonb_agg(cited.url order by cited.first_ordinal), '[]'::jsonb)
          from (
            select private.catalog_public_citation(source.url, withheld) as url,
                   pg_catalog.min(source.ordinal) as first_ordinal
              from pg_catalog.unnest(o.source_urls) with ordinality as source(url, ordinal)
             group by 1
          ) as cited
         where cited.url is not null
      ) end
    )
    into organization
    from private.catalog_organizations as o
   where o.catalog_key = p_key
     and (p_country is null or o.country = p_country)
     and (p_subdivision is null or o.subdivision = p_subdivision)
     and o.retired_release_id is null
     and o.duplicate_of is null
     and private.catalog_registry_identity_visible(o.union_org_id)
     and exists (select 1 from private.catalog_releases as r where r.status = 'active');
  if organization is null then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  answer := pg_catalog.jsonb_build_object(
    'found', true,
    'documentLinks', case when caller_is_member then 'included' else 'members' end,
    'organization', organization,
    'parents', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.depth, item.edge_kind, item.edge_key)
        from (
          select walked.depth, walked.edge_kind, walked.edge_key,
            pg_catalog.jsonb_build_object(
              'country', walked.country, 'subdivision', walked.subdivision, 'postalCode', walked.postal_code,
              'language', walked.language, 'timezone', walked.timezone, 'localeUnknowns', walked.locale_unknowns,
              'depth', walked.depth,
              'childKey', walked.child_key,
              'parentKey', parent.catalog_key,
              'parentName', parent.name,
              'parentLabel', private.catalog_scrub_text(walked.parent_label),
              'edgeKind', walked.edge_kind,
              'certainty', walked.certainty,
              'sourceUrl', case when caller_is_member then walked.source_url else private.catalog_public_citation(walked.source_url, withheld) end
            ) as payload
            from (
              with recursive chain as (
                select e.edge_key, e.child_key, e.parent_key, e.parent_label, e.edge_kind, e.certainty, e.source_url, e.country, e.subdivision, e.postal_code, e.language, e.timezone, e.locale_unknowns,
                       1 as depth
                  from private.catalog_edges as e
                 where e.child_key = p_key
                   and e.retired_release_id is null
                union
                select e.edge_key, e.child_key, e.parent_key, e.parent_label, e.edge_kind, e.certainty, e.source_url, e.country, e.subdivision, e.postal_code, e.language, e.timezone, e.locale_unknowns,
                       chain.depth + 1
                  from chain
                  -- The walk continues only through a visible organization.
                  join private.catalog_organizations as via
                    on via.catalog_key = chain.parent_key
                   and via.retired_release_id is null
                   and via.duplicate_of is null
                   and private.catalog_registry_identity_visible(via.union_org_id)
                  join private.catalog_edges as e on e.child_key = via.catalog_key
                 where chain.depth < 8
                   and e.retired_release_id is null
              )
              select distinct on (chain.edge_key)
                     chain.edge_key, chain.child_key, chain.parent_key, chain.parent_label, chain.edge_kind,
                     chain.certainty, chain.source_url, chain.country, chain.subdivision, chain.postal_code, chain.language, chain.timezone, chain.locale_unknowns, chain.depth
                from chain
               order by chain.edge_key, chain.depth
            ) as walked
            left join private.catalog_organizations as parent
              on parent.catalog_key = walked.parent_key
             and parent.retired_release_id is null
             and parent.duplicate_of is null
             and private.catalog_registry_identity_visible(parent.union_org_id)
           -- An edge to a retired or duplicate organization is left out, as
           -- that organization's own profile is; a label-only edge stays.
           where walked.parent_key is null or parent.catalog_key is not null
           order by walked.depth, walked.edge_kind, walked.edge_key
           limit 100
        ) as item
    ), '[]'::jsonb),
    'children', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.sort_name, item.edge_key)
        from (
          select child.name as sort_name, e.edge_key,
            pg_catalog.jsonb_build_object(
              'country', child.country, 'subdivision', child.subdivision, 'postalCode', child.postal_code, 'language', child.language, 'timezone', child.timezone, 'localeUnknowns', child.locale_unknowns,
              'key', child.catalog_key,
              'name', child.name,
              'tier', child.tier,
              'localNumber', child.local_number,
              'city', child.city,
              'state', child.state,
              'edgeKind', e.edge_kind,
              'certainty', e.certainty
            ) as payload
            from private.catalog_edges as e
            join private.catalog_organizations as child on child.catalog_key = e.child_key
           where e.parent_key = p_key
             and e.retired_release_id is null
             and child.retired_release_id is null
             and child.duplicate_of is null
             and private.catalog_registry_identity_visible(child.union_org_id)
           order by child.name, e.edge_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'childrenTotal', (
      select pg_catalog.count(*)
        from private.catalog_edges as e
        join private.catalog_organizations as child on child.catalog_key = e.child_key
       where e.parent_key = p_key
         and e.retired_release_id is null
         and child.retired_release_id is null
         and child.duplicate_of is null
         and private.catalog_registry_identity_visible(child.union_org_id)
    ),
    'subunits', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.kind, item.name, item.subunit_key)
        from (
          select s.kind, s.name, s.subunit_key,
            pg_catalog.jsonb_build_object(
              'country', s.country, 'subdivision', s.subdivision, 'postalCode', s.postal_code, 'language', s.language, 'timezone', s.timezone, 'localeUnknowns', s.locale_unknowns,
              'key', s.subunit_key,
              'parentKey', s.parent_subunit_key,
              'kind', s.kind,
              'kindLabel', private.catalog_scrub_text(s.kind_label),
              'name', private.catalog_scrub_text(s.name),
              'location', private.catalog_scrub_text(s.location),
              'employer', private.catalog_scrub_text(s.employer),
              'members', s.members,
              'membersSource', private.catalog_scrub_text(s.members_source),
              'densityNote', private.catalog_scrub_text(s.density_note),
              'website', case when caller_is_member then s.website else private.catalog_public_citation(s.website, withheld) end,
              'electionNote', private.catalog_scrub_text(s.election_note),
              'structureNote', private.catalog_scrub_text(s.structure_note),
              'confidence', s.confidence,
              'sourceUrl', case when caller_is_member then s.source_url else private.catalog_public_citation(s.source_url, withheld) end,
              'asOf', s.as_of
            ) as payload
            from private.catalog_subunits as s
           where s.catalog_key = p_key
             and s.retired_release_id is null
           order by s.kind, s.name, s.subunit_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'seatOutlines', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.scope, item.seat_class, item.outline_key)
        from (
          select coalesce(so.subunit_key, '') as scope, so.seat_class, so.outline_key,
            pg_catalog.jsonb_build_object(
              'country', so.country, 'subdivision', so.subdivision, 'postalCode', so.postal_code, 'language', so.language, 'timezone', so.timezone, 'localeUnknowns', so.locale_unknowns,
              'key', so.outline_key,
              'subunitKey', so.subunit_key,
              'seatClass', so.seat_class,
              'title', private.catalog_scrub_text(so.title),
              'listed', so.listed,
              'vacant', so.vacant,
              'sourceUrl', case when caller_is_member then so.source_url else private.catalog_public_citation(so.source_url, withheld) end,
              'asOf', so.as_of
            ) as payload
            from private.catalog_seat_outlines as so
           where so.catalog_key = p_key
             and so.retired_release_id is null
           order by coalesce(so.subunit_key, ''), so.seat_class, so.outline_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'contacts', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.contact_kind, item.contact_key)
        from (
          select c.contact_kind, c.contact_key,
            pg_catalog.jsonb_build_object(
              'country', c.country, 'subdivision', c.subdivision, 'postalCode', c.postal_code, 'language', c.language, 'timezone', c.timezone, 'localeUnknowns', c.locale_unknowns,
              'kind', c.contact_kind,
              'value', case when caller_is_member then c.value else private.catalog_public_citation(c.value, withheld) end,
              'label', private.catalog_scrub_text(c.label),
              'basis', c.basis,
              'sourceUrl', case when caller_is_member then c.source_url else private.catalog_public_citation(c.source_url, withheld) end,
              'asOf', c.as_of
            ) as payload
            from private.catalog_contacts as c
           where c.catalog_key = p_key
             and c.retired_release_id is null
           order by c.contact_kind, c.contact_key
           limit 50
        ) as item
    ), '[]'::jsonb),
    'documents', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.doc_kind, item.document_key)
        from (
          select d.doc_kind, d.document_key,
            pg_catalog.jsonb_build_object(
              'country', d.country, 'subdivision', d.subdivision, 'postalCode', d.postal_code, 'language', d.language, 'timezone', d.timezone, 'localeUnknowns', d.locale_unknowns,
              'key', d.document_key,
              'kind', d.doc_kind,
              'title', private.catalog_scrub_text(d.title),
              'titleDerived', d.title_derived,
              'url', case when caller_is_member then d.url end,
              'urlHost', case when caller_is_member then d.url_host end,
              'asOf', d.as_of,
              'subunitKeys', coalesce((
                select pg_catalog.jsonb_agg(link.subunit_key order by link.subunit_key)
                  from (
                    select ds.subunit_key
                      from private.catalog_document_subunits as ds
                     where ds.document_key = d.document_key
                       and ds.retired_release_id is null
                     order by ds.subunit_key
                     limit 50
                  ) as link
              ), '[]'::jsonb)
            ) as payload
            from private.catalog_documents as d
           where d.catalog_key = p_key
             and d.retired_release_id is null
           order by d.doc_kind, d.document_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'coverage', (
      select pg_catalog.jsonb_build_object(
          'country', cov.country, 'subdivision', cov.subdivision, 'postalCode', cov.postal_code, 'language', cov.language, 'timezone', cov.timezone, 'localeUnknowns', cov.locale_unknowns,
          'band', cov.band,
          'checklist', cov.checklist,
          'subunits', cov.subunits,
          'subunitsWithMembers', cov.subunits_with_members,
          'seatOutlines', cov.seat_outlines,
          'documents', cov.documents,
          'demandBand', cov.demand_band,
          'communityVerifiedOn', cov.community_verified_on,
          'lastResearched', cov.last_researched
        )
        from private.catalog_coverage as cov
       where cov.catalog_key = p_key
    )
  );
  -- Last, every string a visitor gets (names, labels, notes, titles and the
  -- sources above) through the rule as text, so an address in any field,
  -- written alone or inside prose, is judged the same way.
  return case when caller_is_member then answer else private.catalog_public_json(answer, withheld) end;
end;
$function$;
revoke all on function public.get_union_catalog_profile_by_country(text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.get_union_catalog_profile_by_country(text,text,text) to anon, authenticated, service_role;
create or replace function public.get_union_catalog_profile(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select public.get_union_catalog_profile_by_country(p_key,null,null);
$function$;
revoke all on function public.get_union_catalog_profile(text) from public, anon, authenticated, service_role;
grant execute on function public.get_union_catalog_profile(text) to anon, authenticated, service_role;

-- Register only the surfaces changed here in the existing lifecycle review.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select s.kind,s.schema_name,s.table_name,s.object_name,s.definition_hash
from private.account_lifecycle_trigger_surface() as s
where s.kind = 'function' and (
  (s.schema_name = 'public' and pg_catalog.split_part(s.object_name,'(',1) in ('search_union_catalog','get_union_catalog_profile','search_union_catalog_by_country','get_union_catalog_profile_by_country'))
  or (s.schema_name = 'private' and pg_catalog.split_part(s.object_name,'(',1) in
    ('catalog_activate_release','catalog_country_valid','catalog_subdivision_valid','catalog_locale_valid','catalog_language_valid')))
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash = excluded.definition_hash;
do $review$
begin
  if exists(select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after catalog locale change';
  end if;
end;
$review$;
notify pgrst, 'reload schema';
commit;
