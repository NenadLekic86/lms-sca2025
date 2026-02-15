-- Atomic reorder helpers for Course Builder V2.
-- These functions guarantee all-or-nothing position updates.

create or replace function public.v2_reorder_course_topics(
  p_course_id uuid,
  p_org_id uuid,
  p_ordered_topic_ids uuid[],
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_count integer;
  v_payload_count integer;
begin
  if p_course_id is null or p_org_id is null or p_actor_id is null then
    raise exception 'Missing required parameters.';
  end if;
  if p_ordered_topic_ids is null or coalesce(array_length(p_ordered_topic_ids, 1), 0) = 0 then
    raise exception 'No topics to reorder.';
  end if;

  select count(*)::integer
    into v_existing_count
  from public.course_topics t
  where t.course_id = p_course_id
    and t.organization_id = p_org_id;

  v_payload_count := array_length(p_ordered_topic_ids, 1);
  if v_existing_count <> v_payload_count then
    raise exception 'Invalid topic ordering payload.';
  end if;

  if exists (
    select 1
    from unnest(p_ordered_topic_ids) as payload_id
    left join public.course_topics t
      on t.id = payload_id
     and t.course_id = p_course_id
     and t.organization_id = p_org_id
    where t.id is null
  ) then
    raise exception 'Invalid topic ordering payload.';
  end if;

  update public.course_topics as t
     set position = ord.pos - 1,
         updated_at = now(),
         updated_by = p_actor_id
    from (
      select topic_id, pos
      from unnest(p_ordered_topic_ids) with ordinality as u(topic_id, pos)
    ) as ord
   where t.id = ord.topic_id
     and t.course_id = p_course_id
     and t.organization_id = p_org_id;
end;
$$;

grant execute on function public.v2_reorder_course_topics(uuid, uuid, uuid[], uuid) to authenticated, service_role;

create or replace function public.v2_reorder_topic_items(
  p_topic_id uuid,
  p_org_id uuid,
  p_ordered_item_ids uuid[],
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_count integer;
  v_payload_count integer;
begin
  if p_topic_id is null or p_org_id is null or p_actor_id is null then
    raise exception 'Missing required parameters.';
  end if;
  if p_ordered_item_ids is null or coalesce(array_length(p_ordered_item_ids, 1), 0) = 0 then
    raise exception 'No items to reorder.';
  end if;

  select count(*)::integer
    into v_existing_count
  from public.course_topic_items i
  where i.topic_id = p_topic_id
    and i.organization_id = p_org_id;

  v_payload_count := array_length(p_ordered_item_ids, 1);
  if v_existing_count <> v_payload_count then
    raise exception 'Invalid item ordering payload.';
  end if;

  if exists (
    select 1
    from unnest(p_ordered_item_ids) as payload_id
    left join public.course_topic_items i
      on i.id = payload_id
     and i.topic_id = p_topic_id
     and i.organization_id = p_org_id
    where i.id is null
  ) then
    raise exception 'Invalid item ordering payload.';
  end if;

  update public.course_topic_items as i
     set position = ord.pos - 1,
         updated_at = now(),
         updated_by = p_actor_id
    from (
      select item_id, pos
      from unnest(p_ordered_item_ids) with ordinality as u(item_id, pos)
    ) as ord
   where i.id = ord.item_id
     and i.topic_id = p_topic_id
     and i.organization_id = p_org_id;
end;
$$;

grant execute on function public.v2_reorder_topic_items(uuid, uuid, uuid[], uuid) to authenticated, service_role;
