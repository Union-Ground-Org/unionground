import delivery from '../../config/key-assurance-delivery.json' with {type:'json'};
if(delivery.schema!==1 || !/^\d{14}_pin_verified_key_session_assurance\.sql$/u.test(delivery.migration)) throw Error('Invalid key assurance migration binding');
export const keyAssuranceMigrationName=delivery.migration;
export const keyAssuranceMigrationPath=`supabase/migrations/${delivery.migration}`;
export const keyAssuranceMigrationUrl=new URL(`../../${keyAssuranceMigrationPath}`,import.meta.url);
