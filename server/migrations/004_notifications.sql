UPDATE arena_settings
SET settings_json = json_set(settings_json, '$.notifications', json('{"mode":"off","webhookUrl":"","webhookTemplate":"","webhookHeaders":"{}"}'))
WHERE json_type(settings_json, '$.notifications') IS NULL;

UPDATE arena_settings
SET settings_json = json_set(settings_json, '$.notifications.webhookMethod', 'POST')
WHERE json_type(settings_json, '$.notifications.webhookMethod') IS NULL;

UPDATE arena_settings
SET settings_json = json_set(settings_json, '$.notifications.webhookTemplate', '{"title":"{{title}}","body":"{{body}}"}')
WHERE trim(COALESCE(json_extract(settings_json, '$.notifications.webhookTemplate'), '')) = ''
    OR CASE WHEN json_valid(json_extract(settings_json, '$.notifications.webhookTemplate'))
        THEN json(json_extract(settings_json, '$.notifications.webhookTemplate')) END
        = json('{"title":"{{title}}","body":"{{body}}","runId":"{{runId}}","status":"{{status}}","finishedAt":"{{finishedAt}}"}');

UPDATE arena_settings
SET settings_json = json_set(settings_json, '$.notifications.webhookHeaders', '')
WHERE trim(COALESCE(json_extract(settings_json, '$.notifications.webhookHeaders'), '')) IN ('', '{}');
