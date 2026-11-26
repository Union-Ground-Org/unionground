revoke all on function public.submit_public_interest(text, text, text, text, text, text)
  from public, anon, authenticated, service_role;

drop function if exists public.submit_public_interest(text, text, text, text, text, text);
