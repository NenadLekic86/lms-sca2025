-- Storage bucket for Course Builder V2 lesson assets (feature images, lesson videos, attachments).
-- Private bucket: assets are served via signed URLs from server routes.

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'course-lesson-assets') then
    insert into storage.buckets (id, name, public)
    values ('course-lesson-assets', 'course-lesson-assets', false);
  end if;
end $$;

-- Optional policies for service_role (service role bypasses RLS, but keeping explicit policies is fine).
do $$
begin
  -- INSERT
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'course lesson assets service write'
  ) then
    create policy "course lesson assets service write"
    on storage.objects
    for insert
    to service_role
    with check (bucket_id = 'course-lesson-assets');
  end if;

  -- UPDATE
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'course lesson assets service update'
  ) then
    create policy "course lesson assets service update"
    on storage.objects
    for update
    to service_role
    using (bucket_id = 'course-lesson-assets')
    with check (bucket_id = 'course-lesson-assets');
  end if;

  -- DELETE
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'course lesson assets service delete'
  ) then
    create policy "course lesson assets service delete"
    on storage.objects
    for delete
    to service_role
    using (bucket_id = 'course-lesson-assets');
  end if;
end $$;
