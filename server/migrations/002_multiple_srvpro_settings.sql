UPDATE arena_settings
SET settings_json = json_remove(
    json_set(
        settings_json,
        '$.srvpros',
        json_array(
            json_set(
                json_extract(settings_json, '$.srvpro'),
                '$.id', 'srvpro-1',
                '$.name', 'SRVPro 1'
            )
        )
    ),
    '$.srvpro'
)
WHERE json_type(settings_json, '$.srvpros') IS NULL
  AND json_type(settings_json, '$.srvpro') = 'object';
