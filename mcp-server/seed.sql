-- ============================================================
-- Sentinel – seed data  (IDEMPOTENT — safe to re-run)
-- Apply AFTER schema.sql:
--   psql $DATABASE_URL -f seed.sql
--
-- Scenario:
--   • 12 reports clustered around 37.7796° N, 122.4194° W
--     (downtown San Francisco, near Civic Center) — simulating
--     a building-fire event reported from multiple witnesses.
--   • 4 unrelated, scattered reports elsewhere in the city.
--
-- All timestamps are within the last 40 minutes so they fall
-- inside the default since_minutes=45 window of search_reports.
--
-- Idempotency strategy:
--   • Wrapped in a transaction with stop-on-error (default psql behaviour
--     with \set ON_ERROR_STOP on).
--   • The seeded incident uses a fixed UUID + ON CONFLICT DO NOTHING.
--   • Seeded reports use fixed reporter_ids; the DELETE before INSERT
--     removes only seed rows (identified by reporter_id prefix 'reporter-00')
--     so real data is never touched.
-- ============================================================

BEGIN;

-- ---- Seeded incident (fixed UUID, idempotent) ----------------------------
INSERT INTO incidents (id, status, severity, confidence, centroid_lat, centroid_lng)
VALUES (
    'aaaaaaaa-0000-0000-0000-000000000001',
    'INVESTIGATING',
    'HIGH',
    'HIGH',
    37.7796,
    -122.4194
)
ON CONFLICT (id) DO NOTHING;

-- ---- Remove existing seed reports to avoid duplicates on re-run ----------
-- Only touches rows with reporter_ids that belong to this seed script.
DELETE FROM reports
WHERE reporter_id LIKE 'reporter-00%';

-- ---- Building-fire cluster (within ~300 m of Civic Center) ---------------
INSERT INTO reports (text, lat, lng, category, timestamp, reporter_id, incident_id)
VALUES
(
    'There is a massive fire on the 3rd floor of the building on McAllister St — huge smoke column visible from two blocks away.',
    37.7796, -122.4194, 'fire',
    NOW() - INTERVAL '38 minutes',
    'reporter-0001',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'Can smell smoke very strongly near the Civic Center plaza, people evacuating a building.',
    37.7799, -122.4190, 'fire',
    NOW() - INTERVAL '36 minutes',
    'reporter-0002',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'Heard fire alarms going off inside the big building near Van Ness. Flames visible from ground floor windows.',
    37.7794, -122.4198, 'fire',
    NOW() - INTERVAL '35 minutes',
    'reporter-0003',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'Multiple fire trucks arriving at McAllister and Polk. Building is definitely on fire.',
    37.7801, -122.4186, 'fire',
    NOW() - INTERVAL '33 minutes',
    'reporter-0004',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'Black smoke rising near City Hall. Looks like the office building on the north side.',
    37.7792, -122.4189, 'fire',
    NOW() - INTERVAL '31 minutes',
    'reporter-0005',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'Firefighters are on scene at Civic Center, hoses deployed. Traffic being diverted on Van Ness.',
    37.7798, -122.4196, 'fire',
    NOW() - INTERVAL '29 minutes',
    'reporter-0006',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'People are being evacuated from a government building near Fulton and Larkin, smoke everywhere.',
    37.7803, -122.4200, 'fire',
    NOW() - INTERVAL '27 minutes',
    'reporter-0007',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'Strong chemical burning smell near McAllister and Larkin intersection.',
    37.7790, -122.4201, 'hazard',
    NOW() - INTERVAL '25 minutes',
    'reporter-0008',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'I can see orange flames from the 2nd floor windows of the building across from UN Plaza.',
    37.7795, -122.4183, 'fire',
    NOW() - INTERVAL '22 minutes',
    'reporter-0009',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'Power lines near the burning building started sparking. Very dangerous — people nearby.',
    37.7800, -122.4192, 'hazard',
    NOW() - INTERVAL '19 minutes',
    'reporter-0010',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'Smoke inhalation injuries — at least 3 people being treated by paramedics at Civic Center.',
    37.7797, -122.4197, 'fire',
    NOW() - INTERVAL '15 minutes',
    'reporter-0011',
    'aaaaaaaa-0000-0000-0000-000000000001'
),
(
    'Second alarm fire at McAllister St — more units arriving. Building partially evacuated.',
    37.7793, -122.4193, 'fire',
    NOW() - INTERVAL '10 minutes',
    'reporter-0012',
    'aaaaaaaa-0000-0000-0000-000000000001'
);

-- ---- Unrelated scattered reports (NOT part of the fire cluster) ----------
INSERT INTO reports (text, lat, lng, category, timestamp, reporter_id, incident_id)
VALUES
(
    'Suspicious package left unattended near the Ferry Building on the Embarcadero.',
    37.7955, -122.3937, 'hazard',
    NOW() - INTERVAL '20 minutes',
    'reporter-0013',
    NULL
),
(
    'Street fight outside a bar on Mission St near 16th. Police needed.',
    37.7645, -122.4198, 'crime',
    NOW() - INTERVAL '30 minutes',
    'reporter-0014',
    NULL
),
(
    'Car accident at the intersection of Market and Castro — minor injuries, blocking traffic.',
    37.7626, -122.4350, 'hazard',
    NOW() - INTERVAL '12 minutes',
    'reporter-0015',
    NULL
),
(
    'Noise complaint — loud party in Golden Gate Park near the bandshell, going on for hours.',
    37.7694, -122.4862, 'other',
    NOW() - INTERVAL '5 minutes',
    'reporter-0016',
    NULL
);

COMMIT;
