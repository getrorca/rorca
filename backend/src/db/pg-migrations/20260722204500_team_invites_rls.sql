-- Enforce recipient/admin visibility for signed team invites.
-- Application tables only; this migration never touches pgboss.*.

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_invites_select_authorized ON team_invites;
CREATE POLICY team_invites_select_authorized
ON team_invites
FOR SELECT
USING (
  lower(email) = lower(COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    ''
  ))
  OR EXISTS (
    SELECT 1
    FROM teams team
    JOIN users owner_user ON owner_user.id = team.owner_id
    WHERE team.id = team_invites.team_id
      AND owner_user.auth_id::text = current_setting('request.jwt.claim.sub', true)
  )
  OR EXISTS (
    SELECT 1
    FROM team_members member
    JOIN users member_user ON member_user.id = member.user_id
    WHERE member.team_id = team_invites.team_id
      AND member.role = 'admin'
      AND member.accepted_at IS NOT NULL
      AND member_user.auth_id::text = current_setting('request.jwt.claim.sub', true)
  )
);

DROP POLICY IF EXISTS team_invites_manage_admin ON team_invites;
CREATE POLICY team_invites_manage_admin
ON team_invites
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM teams team
    JOIN users owner_user ON owner_user.id = team.owner_id
    WHERE team.id = team_invites.team_id
      AND owner_user.auth_id::text = current_setting('request.jwt.claim.sub', true)
  )
  OR EXISTS (
    SELECT 1 FROM team_members member
    JOIN users member_user ON member_user.id = member.user_id
    WHERE member.team_id = team_invites.team_id
      AND member.role = 'admin'
      AND member.accepted_at IS NOT NULL
      AND member_user.auth_id::text = current_setting('request.jwt.claim.sub', true)
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM teams team
    JOIN users owner_user ON owner_user.id = team.owner_id
    WHERE team.id = team_invites.team_id
      AND owner_user.auth_id::text = current_setting('request.jwt.claim.sub', true)
  )
  OR EXISTS (
    SELECT 1 FROM team_members member
    JOIN users member_user ON member_user.id = member.user_id
    WHERE member.team_id = team_invites.team_id
      AND member.role = 'admin'
      AND member.accepted_at IS NOT NULL
      AND member_user.auth_id::text = current_setting('request.jwt.claim.sub', true)
  )
);
