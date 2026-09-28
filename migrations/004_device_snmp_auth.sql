-- SNMP authentication now lives on the device row (plain JSON, typed in when the device is added) instead of
-- an encrypted, shared credential. Credentials remain only for notification-channel secrets.
--
-- The old secrets are encrypted and cannot be decrypted in SQL, so devices that used SNMP lose their auth here:
-- SNMP is switched off on them and the auth has to be entered again on the device.

alter table devices add column snmp_auth jsonb;

alter table devices drop constraint devices_snmp_needs_credential;
update devices set snmp_enabled = false where snmp_enabled;
alter table devices drop column snmp_credential_id;
alter table devices add constraint devices_snmp_needs_auth check (not snmp_enabled or snmp_auth is not null);

delete from credentials where type in ('snmp_v1', 'snmp_v2c', 'snmp_v3');
alter table credentials drop constraint credentials_type_check;
alter table credentials add constraint credentials_type_check check (type in ('telegram_bot', 'webhook_secret'));
