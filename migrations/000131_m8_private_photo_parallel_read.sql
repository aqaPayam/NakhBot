-- Custody verification reads only permanent relations in the caller's snapshot.
-- It acquires no locks, changes no state, and uses no backend-local information.
-- Permit the existing moderation integrity query to retain parallel reads when
-- the independently verified private-copy source is included.
ALTER FUNCTION identity.deletion_private_photo_valid(uuid) PARALLEL SAFE;
