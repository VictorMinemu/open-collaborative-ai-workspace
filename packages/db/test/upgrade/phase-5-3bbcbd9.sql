-- OCW upgrade baseline (N-1): schema + synthetic data at git ref 3bbcbd9 (3bbcbd9).
-- Regenerate: pnpm --filter @ocw/db upgrade:baseline 3bbcbd9
-- Synthetic data only (packages/db/test/upgrade/seed-phase-5.sql); fixed test keys; no real person, token or path.
-- Plain pg_dump as ocw_migrator; load with psql as ocw_migrator after the role bootstrap (apps/api/src/upgrade.int.test.ts).
--
-- PostgreSQL database dump
--

\restrict ocwupgradebaseline

-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: ocw_migrator
--

CREATE SCHEMA app;


ALTER SCHEMA app OWNER TO ocw_migrator;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: ocw_migrator
--

CREATE SCHEMA auth;


ALTER SCHEMA auth OWNER TO ocw_migrator;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: ocw_migrator
--

CREATE SCHEMA drizzle;


ALTER SCHEMA drizzle OWNER TO ocw_migrator;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA app;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA app;


--
-- Name: EXTENSION unaccent; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';


--
-- Name: due_attachment_sweeps(integer, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: ocw_migrator
--

CREATE FUNCTION app.due_attachment_sweeps(p_limit integer, p_now timestamp with time zone DEFAULT now()) RETURNS TABLE(id uuid, organization_id uuid, conversation_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT a.id, a.organization_id, a.conversation_id FROM app.attachments a
  WHERE a.purged_at IS NULL
    AND (
      (a.status IN ('pending', 'rejected') AND a.created_at < p_now - interval '24 hours')
      OR (a.status = 'deleted' AND coalesce(a.deleted_at, a.created_at) < p_now - interval '30 days')
    )
  ORDER BY a.created_at
  LIMIT least(greatest(p_limit, 1), 1000)
$$;


ALTER FUNCTION app.due_attachment_sweeps(p_limit integer, p_now timestamp with time zone) OWNER TO ocw_migrator;

--
-- Name: lookup_agent_credential(text); Type: FUNCTION; Schema: app; Owner: ocw_migrator
--

CREATE FUNCTION app.lookup_agent_credential(p_token_hash text) RETURNS TABLE(credential_id uuid, organization_id uuid, agent_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT c.id, c.organization_id, c.agent_id FROM app.agent_credentials c
  WHERE c.token_hash = p_token_hash AND c.revoked_at IS NULL
$$;


ALTER FUNCTION app.lookup_agent_credential(p_token_hash text) OWNER TO ocw_migrator;

--
-- Name: lookup_device_enrollment(text); Type: FUNCTION; Schema: app; Owner: ocw_migrator
--

CREATE FUNCTION app.lookup_device_enrollment(p_code_hash text) RETURNS TABLE(organization_id uuid, user_id uuid, expires_at timestamp with time zone, consumed_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT e.organization_id, e.user_id, e.expires_at, e.consumed_at FROM app.device_enrollments e
  WHERE e.code_hash = p_code_hash
$$;


ALTER FUNCTION app.lookup_device_enrollment(p_code_hash text) OWNER TO ocw_migrator;

--
-- Name: lookup_device_token(text); Type: FUNCTION; Schema: app; Owner: ocw_migrator
--

CREATE FUNCTION app.lookup_device_token(p_token_hash text) RETURNS TABLE(device_id uuid, organization_id uuid, owner_user_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT d.id, d.organization_id, d.owner_user_id FROM app.devices d
  WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL
$$;


ALTER FUNCTION app.lookup_device_token(p_token_hash text) OWNER TO ocw_migrator;

--
-- Name: stale_ai_generations(integer, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: ocw_migrator
--

CREATE FUNCTION app.stale_ai_generations(p_limit integer, p_before timestamp with time zone) RETURNS TABLE(id uuid, organization_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT g.id, g.organization_id FROM app.ai_generations g
  WHERE g.status = 'running' AND g.heartbeat_at < p_before
  ORDER BY g.heartbeat_at
  LIMIT least(greatest(p_limit, 1), 1000)
$$;


ALTER FUNCTION app.stale_ai_generations(p_limit integer, p_before timestamp with time zone) OWNER TO ocw_migrator;

--
-- Name: ocw_en; Type: TEXT SEARCH CONFIGURATION; Schema: app; Owner: ocw_migrator
--

CREATE TEXT SEARCH CONFIGURATION app.ocw_en (
    PARSER = pg_catalog."default" );

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR asciiword WITH english_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR word WITH app.unaccent, english_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR numword WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR email WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR url WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR host WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR sfloat WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR version WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR hword_numpart WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR hword_part WITH app.unaccent, english_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR hword_asciipart WITH english_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR numhword WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR asciihword WITH english_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR hword WITH app.unaccent, english_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR url_path WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR file WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR "float" WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR "int" WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_en
    ADD MAPPING FOR uint WITH simple;


ALTER TEXT SEARCH CONFIGURATION app.ocw_en OWNER TO ocw_migrator;

--
-- Name: ocw_es; Type: TEXT SEARCH CONFIGURATION; Schema: app; Owner: ocw_migrator
--

CREATE TEXT SEARCH CONFIGURATION app.ocw_es (
    PARSER = pg_catalog."default" );

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR asciiword WITH spanish_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR word WITH app.unaccent, spanish_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR numword WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR email WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR url WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR host WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR sfloat WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR version WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR hword_numpart WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR hword_part WITH app.unaccent, spanish_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR hword_asciipart WITH spanish_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR numhword WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR asciihword WITH spanish_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR hword WITH app.unaccent, spanish_stem;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR url_path WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR file WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR "float" WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR "int" WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_es
    ADD MAPPING FOR uint WITH simple;


ALTER TEXT SEARCH CONFIGURATION app.ocw_es OWNER TO ocw_migrator;

--
-- Name: ocw_simple; Type: TEXT SEARCH CONFIGURATION; Schema: app; Owner: ocw_migrator
--

CREATE TEXT SEARCH CONFIGURATION app.ocw_simple (
    PARSER = pg_catalog."default" );

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR asciiword WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR word WITH app.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR numword WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR email WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR url WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR host WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR sfloat WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR version WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR hword_numpart WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR hword_part WITH app.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR hword_asciipart WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR numhword WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR asciihword WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR hword WITH app.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR url_path WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR file WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR "float" WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR "int" WITH simple;

ALTER TEXT SEARCH CONFIGURATION app.ocw_simple
    ADD MAPPING FOR uint WITH simple;


ALTER TEXT SEARCH CONFIGURATION app.ocw_simple OWNER TO ocw_migrator;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_credentials; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.agent_credentials (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    agent_id uuid,
    kind text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY app.agent_credentials FORCE ROW LEVEL SECURITY;


ALTER TABLE app.agent_credentials OWNER TO ocw_migrator;

--
-- Name: agent_limit_notices; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.agent_limit_notices (
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    day date NOT NULL
);

ALTER TABLE ONLY app.agent_limit_notices FORCE ROW LEVEL SECURITY;


ALTER TABLE app.agent_limit_notices OWNER TO ocw_migrator;

--
-- Name: agent_memories; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.agent_memories (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    user_id uuid NOT NULL,
    text text NOT NULL,
    source_event_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_memories_text_len_check CHECK ((char_length(text) <= 500))
);

ALTER TABLE ONLY app.agent_memories FORCE ROW LEVEL SECURITY;


ALTER TABLE app.agent_memories OWNER TO ocw_migrator;

--
-- Name: agent_tool_calls; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.agent_tool_calls (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    event_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    user_id uuid NOT NULL,
    tool text NOT NULL,
    source_kind text NOT NULL,
    source_id uuid,
    target text,
    decision text NOT NULL,
    reason text,
    status text,
    result_count integer,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT agent_tool_calls_decision_check CHECK ((decision = ANY (ARRAY['allowed'::text, 'denied'::text]))),
    CONSTRAINT agent_tool_calls_source_kind_check CHECK ((source_kind = ANY (ARRAY['builtin'::text, 'mcp'::text, 'plugin'::text]))),
    CONSTRAINT agent_tool_calls_status_check CHECK (((status IS NULL) OR (status = ANY (ARRAY['ok'::text, 'error'::text, 'blocked'::text]))))
);

ALTER TABLE ONLY app.agent_tool_calls FORCE ROW LEVEL SECURITY;


ALTER TABLE app.agent_tool_calls OWNER TO ocw_migrator;

--
-- Name: agent_turns; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.agent_turns (
    event_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    conversation_kind text NOT NULL,
    message_id uuid NOT NULL,
    tools text[] DEFAULT '{}'::text[] NOT NULL,
    tool_flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    tool_calls integer DEFAULT 0 NOT NULL,
    web_calls integer DEFAULT 0 NOT NULL,
    tainted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.agent_turns FORCE ROW LEVEL SECURITY;


ALTER TABLE app.agent_turns OWNER TO ocw_migrator;

--
-- Name: agent_usage_daily; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.agent_usage_daily (
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    day date NOT NULL,
    turns integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY app.agent_usage_daily FORCE ROW LEVEL SECURITY;


ALTER TABLE app.agent_usage_daily OWNER TO ocw_migrator;

--
-- Name: agents; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.agents (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    username text NOT NULL,
    avatar_url text,
    description text,
    instructions text NOT NULL,
    model_provider text NOT NULL,
    model_id text NOT NULL,
    runtime text DEFAULT 'openclaw'::text NOT NULL,
    status text DEFAULT 'provisioning'::text NOT NULL,
    status_message text,
    runtime_ref jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    scope text DEFAULT 'team'::text NOT NULL,
    owner_user_id uuid,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT agents_owner_scope_check CHECK (((scope = 'personal'::text) = (owner_user_id IS NOT NULL))),
    CONSTRAINT agents_scope_check CHECK ((scope = ANY (ARRAY['team'::text, 'personal'::text])))
);

ALTER TABLE ONLY app.agents FORCE ROW LEVEL SECURITY;


ALTER TABLE app.agents OWNER TO ocw_migrator;

--
-- Name: ai_chat_policies; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.ai_chat_policies (
    organization_id uuid NOT NULL,
    chatgpt_plan_enabled boolean DEFAULT true NOT NULL,
    org_keys_enabled boolean DEFAULT true NOT NULL,
    plan_allowed_models text[] DEFAULT '{}'::text[] NOT NULL,
    org_key_daily_generations integer DEFAULT 200,
    org_key_daily_cost_micros bigint,
    plan_daily_generations integer,
    concurrent_generations_per_user integer DEFAULT 3 NOT NULL,
    max_context_tokens integer DEFAULT 64000 NOT NULL,
    web_enabled boolean DEFAULT true NOT NULL,
    title_models jsonb DEFAULT '{}'::jsonb NOT NULL,
    chatgpt_host_id text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.ai_chat_policies FORCE ROW LEVEL SECURITY;


ALTER TABLE app.ai_chat_policies OWNER TO ocw_migrator;

--
-- Name: ai_chat_shares; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.ai_chat_shares (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    created_by uuid NOT NULL,
    title text NOT NULL,
    snapshot jsonb NOT NULL,
    attachment_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY app.ai_chat_shares FORCE ROW LEVEL SECURITY;


ALTER TABLE app.ai_chat_shares OWNER TO ocw_migrator;

--
-- Name: ai_chats; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.ai_chats (
    conversation_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    title_source text DEFAULT 'heuristic'::text NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    use_personal_instructions boolean DEFAULT true NOT NULL,
    tools jsonb DEFAULT '{"web": false}'::jsonb NOT NULL,
    last_model jsonb,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_chats_instructions_len_check CHECK ((char_length(instructions) <= 8000)),
    CONSTRAINT ai_chats_title_source_check CHECK ((title_source = ANY (ARRAY['user'::text, 'heuristic'::text, 'auto'::text])))
);

ALTER TABLE ONLY app.ai_chats FORCE ROW LEVEL SECURITY;


ALTER TABLE app.ai_chats OWNER TO ocw_migrator;

--
-- Name: ai_generations; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.ai_generations (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    user_message_id uuid,
    assistant_message_id uuid NOT NULL,
    requester_user_id uuid NOT NULL,
    backend text NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    error_code text,
    error_param text,
    finish_reason text,
    partial_text text DEFAULT ''::text NOT NULL,
    instance_id text NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    web_used boolean DEFAULT false NOT NULL,
    source_domains text[] DEFAULT '{}'::text[] NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT ai_generations_backend_check CHECK ((backend = ANY (ARRAY['chatgpt_plan'::text, 'org_key'::text, 'mock'::text]))),
    CONSTRAINT ai_generations_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'stopped'::text, 'failed'::text, 'interrupted'::text])))
);

ALTER TABLE ONLY app.ai_generations FORCE ROW LEVEL SECURITY;


ALTER TABLE app.ai_generations OWNER TO ocw_migrator;

--
-- Name: ai_usage_daily; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.ai_usage_daily (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    day date NOT NULL,
    backend_class text NOT NULL,
    generations integer DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cost_micros_usd bigint DEFAULT 0 NOT NULL,
    CONSTRAINT ai_usage_daily_backend_class_check CHECK ((backend_class = ANY (ARRAY['org_key'::text, 'chatgpt_plan'::text])))
);

ALTER TABLE ONLY app.ai_usage_daily FORCE ROW LEVEL SECURITY;


ALTER TABLE app.ai_usage_daily OWNER TO ocw_migrator;

--
-- Name: ai_usage_records; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.ai_usage_records (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    generation_id uuid NOT NULL,
    kind text NOT NULL,
    requester_user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid,
    backend text NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    input_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    cached_input_tokens integer,
    reasoning_tokens integer,
    estimated boolean DEFAULT false NOT NULL,
    cost_micros_usd bigint,
    price_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_usage_records_kind_check CHECK ((kind = ANY (ARRAY['chat'::text, 'title'::text])))
);

ALTER TABLE ONLY app.ai_usage_records FORCE ROW LEVEL SECURITY;


ALTER TABLE app.ai_usage_records OWNER TO ocw_migrator;

--
-- Name: ai_user_preferences; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.ai_user_preferences (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    default_model jsonb,
    web_default boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_user_preferences_instructions_len_check CHECK ((char_length(instructions) <= 8000))
);

ALTER TABLE ONLY app.ai_user_preferences FORCE ROW LEVEL SECURITY;


ALTER TABLE app.ai_user_preferences OWNER TO ocw_migrator;

--
-- Name: attachments; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.attachments (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid,
    uploader_id uuid NOT NULL,
    filename text NOT NULL,
    declared_type text NOT NULL,
    content_type text,
    size_bytes bigint NOT NULL,
    sha256 text,
    status text DEFAULT 'pending'::text NOT NULL,
    scan_status text DEFAULT 'not_scanned'::text NOT NULL,
    width integer,
    height integer,
    has_renditions boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    purged_at timestamp with time zone,
    CONSTRAINT attachments_scan_status_check CHECK ((scan_status = 'not_scanned'::text)),
    CONSTRAINT attachments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'rejected'::text, 'deleted'::text])))
);

ALTER TABLE ONLY app.attachments FORCE ROW LEVEL SECURITY;


ALTER TABLE app.attachments OWNER TO ocw_migrator;

--
-- Name: audit_events; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.audit_events (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid,
    agent_id uuid,
    user_id uuid,
    device_id uuid,
    session_id text,
    client_kind text,
    resource_type text NOT NULL,
    resource_id text,
    action text NOT NULL,
    result text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    trace_id text
);

ALTER TABLE ONLY app.audit_events FORCE ROW LEVEL SECURITY;


ALTER TABLE app.audit_events OWNER TO ocw_migrator;

--
-- Name: bot_policies; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.bot_policies (
    organization_id uuid NOT NULL,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    search_provider text DEFAULT 'duckduckgo'::text NOT NULL,
    max_personal_bots_per_user integer DEFAULT 3 NOT NULL,
    personal_daily_limit_max integer DEFAULT 100 NOT NULL,
    personal_allowed_models text[] DEFAULT '{}'::text[] NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.bot_policies FORCE ROW LEVEL SECURITY;


ALTER TABLE app.bot_policies OWNER TO ocw_migrator;

--
-- Name: bot_tool_grants; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.bot_tool_grants (
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id uuid NOT NULL,
    tool_name text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bot_tool_grants_source_kind_check CHECK ((source_kind = ANY (ARRAY['mcp'::text, 'plugin'::text])))
);

ALTER TABLE ONLY app.bot_tool_grants FORCE ROW LEVEL SECURITY;


ALTER TABLE app.bot_tool_grants OWNER TO ocw_migrator;

--
-- Name: cell_plugin_tools; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.cell_plugin_tools (
    organization_id uuid NOT NULL,
    plugin_row_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    side_effecting boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY app.cell_plugin_tools FORCE ROW LEVEL SECURITY;


ALTER TABLE app.cell_plugin_tools OWNER TO ocw_migrator;

--
-- Name: cell_plugins; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.cell_plugins (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    package_name text NOT NULL,
    plugin_id text,
    version text NOT NULL,
    channel text NOT NULL,
    publisher text,
    artifact_sha256 text NOT NULL,
    npm_integrity text,
    artifact_url text,
    risk text NOT NULL,
    risk_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    declared jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    status_detail text,
    org_enabled boolean DEFAULT true NOT NULL,
    personal_allowed boolean DEFAULT false NOT NULL,
    trusted_chaining boolean DEFAULT false NOT NULL,
    flow_id uuid,
    approved_by uuid,
    approved_at timestamp with time zone,
    installed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cell_plugins_channel_check CHECK ((channel = ANY (ARRAY['official'::text, 'community'::text]))),
    CONSTRAINT cell_plugins_risk_check CHECK ((risk = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'refuse'::text]))),
    CONSTRAINT cell_plugins_status_check CHECK ((status = ANY (ARRAY['approved'::text, 'installing'::text, 'installed'::text, 'failed'::text, 'uninstalling'::text, 'uninstalled'::text])))
);

ALTER TABLE ONLY app.cell_plugins FORCE ROW LEVEL SECURITY;


ALTER TABLE app.cell_plugins OWNER TO ocw_migrator;

--
-- Name: conversation_members; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.conversation_members (
    conversation_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    member_kind text NOT NULL,
    member_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_read_seq bigint DEFAULT 0 NOT NULL,
    notify_level text DEFAULT 'default'::text NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    CONSTRAINT conversation_members_notify_level_check CHECK ((notify_level = ANY (ARRAY['default'::text, 'all'::text, 'mentions'::text, 'nothing'::text])))
);

ALTER TABLE ONLY app.conversation_members FORCE ROW LEVEL SECURITY;


ALTER TABLE app.conversation_members OWNER TO ocw_migrator;

--
-- Name: conversations; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.conversations (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    kind text NOT NULL,
    name text,
    slug text,
    topic text,
    visibility text DEFAULT 'public'::text NOT NULL,
    parent_conversation_id uuid,
    root_message_id uuid,
    created_by uuid,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dm_key text,
    unit_id uuid
);

ALTER TABLE ONLY app.conversations FORCE ROW LEVEL SECURITY;


ALTER TABLE app.conversations OWNER TO ocw_migrator;

--
-- Name: device_commands; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.device_commands (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    device_id uuid NOT NULL,
    work_session_id uuid,
    kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    acked_at timestamp with time zone
);

ALTER TABLE ONLY app.device_commands FORCE ROW LEVEL SECURITY;


ALTER TABLE app.device_commands OWNER TO ocw_migrator;

--
-- Name: device_enrollments; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.device_enrollments (
    code_hash text NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.device_enrollments FORCE ROW LEVEL SECURITY;


ALTER TABLE app.device_enrollments OWNER TO ocw_migrator;

--
-- Name: device_grants; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.device_grants (
    organization_id uuid NOT NULL,
    device_id uuid NOT NULL,
    principal_kind text NOT NULL,
    principal_id uuid NOT NULL,
    max_mode text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    CONSTRAINT device_grants_max_mode_ck CHECK ((max_mode = ANY (ARRAY['default'::text, 'acceptEdits'::text, 'plan'::text, 'auto'::text, 'fullAccess'::text]))),
    CONSTRAINT device_grants_principal_kind_ck CHECK ((principal_kind = ANY (ARRAY['user'::text, 'unit'::text])))
);

ALTER TABLE ONLY app.device_grants FORCE ROW LEVEL SECURITY;


ALTER TABLE app.device_grants OWNER TO ocw_migrator;

--
-- Name: devices; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.devices (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    token_hash text NOT NULL,
    status text DEFAULT 'offline'::text NOT NULL,
    last_seen_at timestamp with time zone,
    runtime_info jsonb DEFAULT '[]'::jsonb NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    daemon_version text,
    shared boolean DEFAULT false NOT NULL,
    full_access_opt_in boolean DEFAULT false NOT NULL,
    share_max_mode text DEFAULT 'acceptEdits'::text NOT NULL,
    runtime_catalog jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT devices_share_max_mode_ck CHECK ((share_max_mode = ANY (ARRAY['default'::text, 'acceptEdits'::text, 'plan'::text, 'auto'::text, 'fullAccess'::text])))
);

ALTER TABLE ONLY app.devices FORCE ROW LEVEL SECURITY;


ALTER TABLE app.devices OWNER TO ocw_migrator;

--
-- Name: mcp_server_tools; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.mcp_server_tools (
    organization_id uuid NOT NULL,
    server_id uuid NOT NULL,
    name text NOT NULL,
    openclaw_name text NOT NULL,
    title text,
    description text,
    read_only boolean DEFAULT false NOT NULL,
    destructive boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY app.mcp_server_tools FORCE ROW LEVEL SECURITY;


ALTER TABLE app.mcp_server_tools OWNER TO ocw_migrator;

--
-- Name: mcp_servers; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.mcp_servers (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    safe_name text NOT NULL,
    transport text NOT NULL,
    url text,
    sandbox_server text,
    headers jsonb DEFAULT '[]'::jsonb NOT NULL,
    org_enabled boolean DEFAULT true NOT NULL,
    personal_allowed boolean DEFAULT false NOT NULL,
    trusted_chaining boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    status_detail text,
    probed_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_servers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'probing'::text, 'ready'::text, 'error'::text]))),
    CONSTRAINT mcp_servers_transport_check CHECK ((transport = ANY (ARRAY['streamable-http'::text, 'sse'::text, 'sandboxed-stdio'::text])))
);

ALTER TABLE ONLY app.mcp_servers FORCE ROW LEVEL SECURITY;


ALTER TABLE app.mcp_servers OWNER TO ocw_migrator;

--
-- Name: message_pins; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.message_pins (
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    pinned_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.message_pins FORCE ROW LEVEL SECURITY;


ALTER TABLE app.message_pins OWNER TO ocw_migrator;

--
-- Name: message_reactions; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.message_reactions (
    organization_id uuid NOT NULL,
    message_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    emoji text NOT NULL,
    member_kind text NOT NULL,
    member_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_reactions_emoji_len_check CHECK ((char_length(emoji) <= 32)),
    CONSTRAINT message_reactions_member_kind_check CHECK ((member_kind = ANY (ARRAY['user'::text, 'agent'::text])))
);

ALTER TABLE ONLY app.message_reactions FORCE ROW LEVEL SECURITY;


ALTER TABLE app.message_reactions OWNER TO ocw_migrator;

--
-- Name: message_saves; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.message_saves (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    message_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.message_saves FORCE ROW LEVEL SECURITY;


ALTER TABLE app.message_saves OWNER TO ocw_migrator;

--
-- Name: message_versions; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.message_versions (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    message_id uuid NOT NULL,
    version integer NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    mentions jsonb DEFAULT '[]'::jsonb NOT NULL,
    edited_by_kind text NOT NULL,
    edited_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_versions_edited_by_kind_check CHECK ((edited_by_kind = ANY (ARRAY['user'::text, 'agent'::text, 'system'::text]))),
    CONSTRAINT message_versions_kind_check CHECK ((kind = ANY (ARRAY['edit'::text, 'delete'::text, 'regenerate'::text])))
);

ALTER TABLE ONLY app.message_versions FORCE ROW LEVEL SECURITY;


ALTER TABLE app.message_versions OWNER TO ocw_migrator;

--
-- Name: messages; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.messages (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    seq bigint NOT NULL,
    author_kind text NOT NULL,
    author_id uuid,
    body text NOT NULL,
    mentions jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    thread_id uuid,
    reply_count integer DEFAULT 0 NOT NULL,
    last_reply_at timestamp with time zone,
    client_kind text,
    session_id text,
    client_message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    search_tsv tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('app.ocw_simple'::regconfig, body), 'A'::"char") || to_tsvector('app.ocw_es'::regconfig, body)) || to_tsvector('app.ocw_en'::regconfig, body))) STORED
);

ALTER TABLE ONLY app.messages FORCE ROW LEVEL SECURITY;


ALTER TABLE app.messages OWNER TO ocw_migrator;

--
-- Name: model_providers; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.model_providers (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    provider text NOT NULL,
    secret_id uuid,
    allowed_models text[] DEFAULT '{}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    key_hint text,
    base_url text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account jsonb,
    secret_ref jsonb
);

ALTER TABLE ONLY app.model_providers FORCE ROW LEVEL SECURITY;


ALTER TABLE app.model_providers OWNER TO ocw_migrator;

--
-- Name: notification_prefs; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.notification_prefs (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    dnd_until timestamp with time zone,
    desktop_enabled boolean DEFAULT true NOT NULL,
    web_enabled boolean DEFAULT true NOT NULL,
    default_level text DEFAULT 'mentions'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_prefs_default_level_check CHECK ((default_level = ANY (ARRAY['all'::text, 'mentions'::text, 'nothing'::text])))
);

ALTER TABLE ONLY app.notification_prefs FORCE ROW LEVEL SECURITY;


ALTER TABLE app.notification_prefs OWNER TO ocw_migrator;

--
-- Name: notifications; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.notifications (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    thread_root_id uuid,
    actor_kind text NOT NULL,
    actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT notifications_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'agent'::text, 'system'::text]))),
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['mention'::text, 'channel'::text, 'here'::text, 'dm'::text, 'group_dm'::text, 'thread_reply'::text])))
);

ALTER TABLE ONLY app.notifications FORCE ROW LEVEL SECURITY;


ALTER TABLE app.notifications OWNER TO ocw_migrator;

--
-- Name: org_members; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.org_members (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    email text,
    avatar_url text,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status_emoji text,
    status_text text,
    deactivated_at timestamp with time zone,
    CONSTRAINT org_members_role_check CHECK ((role = ANY (ARRAY['standard'::text, 'developer'::text, 'lead'::text, 'admin'::text])))
);

ALTER TABLE ONLY app.org_members FORCE ROW LEVEL SECURITY;


ALTER TABLE app.org_members OWNER TO ocw_migrator;

--
-- Name: org_units; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.org_units (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    parent_id uuid,
    kind text NOT NULL,
    name text NOT NULL,
    path uuid[] NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT org_units_kind_check CHECK ((kind = ANY (ARRAY['department'::text, 'team'::text, 'project'::text])))
);

ALTER TABLE ONLY app.org_units FORCE ROW LEVEL SECURITY;


ALTER TABLE app.org_units OWNER TO ocw_migrator;

--
-- Name: permission_rules; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.permission_rules (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    scope_unit_id uuid,
    subject_kind text NOT NULL,
    subject_id text,
    permission text NOT NULL,
    tool text,
    effect text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT permission_rules_effect_check CHECK ((effect = ANY (ARRAY['allow'::text, 'deny'::text]))),
    CONSTRAINT permission_rules_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['everyone'::text, 'role'::text, 'user'::text, 'agent'::text])))
);

ALTER TABLE ONLY app.permission_rules FORCE ROW LEVEL SECURITY;


ALTER TABLE app.permission_rules OWNER TO ocw_migrator;

--
-- Name: projects; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.projects (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    device_id uuid NOT NULL,
    local_id text NOT NULL,
    name text NOT NULL,
    git_remote text,
    default_branch text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone
);

ALTER TABLE ONLY app.projects FORCE ROW LEVEL SECURITY;


ALTER TABLE app.projects OWNER TO ocw_migrator;

--
-- Name: secrets; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.secrets (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    provider text,
    ciphertext text NOT NULL,
    iv text NOT NULL,
    tag text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.secrets FORCE ROW LEVEL SECURITY;


ALTER TABLE app.secrets OWNER TO ocw_migrator;

--
-- Name: stream_events; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.stream_events (
    stream_id text NOT NULL,
    seq bigint NOT NULL,
    organization_id uuid NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    actor_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.stream_events FORCE ROW LEVEL SECURITY;


ALTER TABLE app.stream_events OWNER TO ocw_migrator;

--
-- Name: streams; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.streams (
    id text NOT NULL,
    organization_id uuid NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY app.streams FORCE ROW LEVEL SECURITY;


ALTER TABLE app.streams OWNER TO ocw_migrator;

--
-- Name: thread_reads; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.thread_reads (
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    root_message_id uuid NOT NULL,
    last_read_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.thread_reads FORCE ROW LEVEL SECURITY;


ALTER TABLE app.thread_reads OWNER TO ocw_migrator;

--
-- Name: unit_memberships; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.unit_memberships (
    organization_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT unit_memberships_role_check CHECK ((role = ANY (ARRAY['member'::text, 'lead'::text])))
);

ALTER TABLE ONLY app.unit_memberships FORCE ROW LEVEL SECURITY;


ALTER TABLE app.unit_memberships OWNER TO ocw_migrator;

--
-- Name: user_model_credentials; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.user_model_credentials (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    secret_id uuid,
    issued_client_id text,
    subject text,
    email text,
    plan_type text,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    access_expires_at timestamp with time zone,
    status text NOT NULL,
    last_error text,
    welcome_seen_at timestamp with time zone,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_model_credentials_provider_check CHECK ((provider = 'chatgpt_plan'::text)),
    CONSTRAINT user_model_credentials_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'needs_reconnect'::text, 'not_eligible'::text, 'plan_usage_disabled'::text])))
);

ALTER TABLE ONLY app.user_model_credentials FORCE ROW LEVEL SECURITY;


ALTER TABLE app.user_model_credentials OWNER TO ocw_migrator;

--
-- Name: work_approvals; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.work_approvals (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    work_session_id uuid NOT NULL,
    request jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by uuid,
    decision text,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone
);

ALTER TABLE ONLY app.work_approvals FORCE ROW LEVEL SECURITY;


ALTER TABLE app.work_approvals OWNER TO ocw_migrator;

--
-- Name: work_prompts; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.work_prompts (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    work_session_id uuid NOT NULL,
    author_user_id uuid NOT NULL,
    origin_device_id uuid,
    body text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone,
    completed_at timestamp with time zone,
    permission_mode text,
    CONSTRAINT work_prompts_permission_mode_ck CHECK ((permission_mode = ANY (ARRAY['default'::text, 'acceptEdits'::text, 'plan'::text, 'auto'::text, 'fullAccess'::text])))
);

ALTER TABLE ONLY app.work_prompts FORCE ROW LEVEL SECURITY;


ALTER TABLE app.work_prompts OWNER TO ocw_migrator;

--
-- Name: work_sessions; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.work_sessions (
    id uuid DEFAULT uuidv7() NOT NULL,
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    project_id uuid NOT NULL,
    device_id uuid NOT NULL,
    runtime text DEFAULT 'claude-code'::text NOT NULL,
    model text,
    permission_mode text DEFAULT 'default'::text NOT NULL,
    status text DEFAULT 'provisioning'::text NOT NULL,
    title text NOT NULL,
    created_by uuid NOT NULL,
    runtime_session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    worktree boolean DEFAULT false NOT NULL,
    branch text,
    last_local_seq bigint DEFAULT 0 NOT NULL,
    last_error text,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    effective_settings jsonb,
    settings_pending boolean DEFAULT false NOT NULL,
    diff_stat jsonb,
    title_source text DEFAULT 'user'::text NOT NULL,
    CONSTRAINT work_sessions_permission_mode_ck CHECK ((permission_mode = ANY (ARRAY['default'::text, 'acceptEdits'::text, 'plan'::text, 'auto'::text, 'fullAccess'::text]))),
    CONSTRAINT work_sessions_title_source_ck CHECK ((title_source = ANY (ARRAY['user'::text, 'heuristic'::text, 'auto'::text])))
);

ALTER TABLE ONLY app.work_sessions FORCE ROW LEVEL SECURITY;


ALTER TABLE app.work_sessions OWNER TO ocw_migrator;

--
-- Name: work_zone_policies; Type: TABLE; Schema: app; Owner: ocw_migrator
--

CREATE TABLE app.work_zone_policies (
    organization_id uuid NOT NULL,
    allowed_permission_modes text[] DEFAULT '{plan,default,acceptEdits,auto}'::text[] NOT NULL,
    allow_full_access boolean DEFAULT false NOT NULL,
    allowed_models jsonb DEFAULT '{}'::jsonb NOT NULL,
    max_effort jsonb DEFAULT '{}'::jsonb NOT NULL,
    allow_fast_mode boolean DEFAULT false NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY app.work_zone_policies FORCE ROW LEVEL SECURITY;


ALTER TABLE app.work_zone_policies OWNER TO ocw_migrator;

--
-- Name: account; Type: TABLE; Schema: auth; Owner: ocw_migrator
--

CREATE TABLE auth.account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE auth.account OWNER TO ocw_migrator;

--
-- Name: instance_setup; Type: TABLE; Schema: auth; Owner: ocw_migrator
--

CREATE TABLE auth.instance_setup (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    organization_id uuid NOT NULL,
    redeemed_by uuid NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE auth.instance_setup OWNER TO ocw_migrator;

--
-- Name: invitation; Type: TABLE; Schema: auth; Owner: ocw_migrator
--

CREATE TABLE auth.invitation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    role text,
    team_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    inviter_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE auth.invitation OWNER TO ocw_migrator;

--
-- Name: jwks; Type: TABLE; Schema: auth; Owner: ocw_migrator
--

CREATE TABLE auth.jwks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    alg text,
    crv text
);


ALTER TABLE auth.jwks OWNER TO ocw_migrator;

--
-- Name: member; Type: TABLE; Schema: auth; Owner: ocw_migrator
--

CREATE TABLE auth.member (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE auth.member OWNER TO ocw_migrator;

--
-- Name: organization; Type: TABLE; Schema: auth; Owner: ocw_migrator
--

CREATE TABLE auth.organization (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    metadata text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone
);


ALTER TABLE auth.organization OWNER TO ocw_migrator;

--
-- Name: session; Type: TABLE; Schema: auth; Owner: ocw_migrator
--

CREATE TABLE auth.session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text,
    user_id uuid NOT NULL,
    active_organization_id uuid,
    client_kind text,
    client_label text
);


ALTER TABLE auth.session OWNER TO ocw_migrator;

--
-- Name: user; Type: TABLE; Schema: auth; Owner: ocw_migrator
--

CREATE TABLE auth."user" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE auth."user" OWNER TO ocw_migrator;

--
-- Name: verification; Type: TABLE; Schema: auth; Owner: ocw_migrator
--

CREATE TABLE auth.verification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE auth.verification OWNER TO ocw_migrator;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: ocw_migrator
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint,
    name text,
    applied_at timestamp with time zone DEFAULT now()
);


ALTER TABLE drizzle.__drizzle_migrations OWNER TO ocw_migrator;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: ocw_migrator
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNER TO ocw_migrator;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: ocw_migrator
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: ocw_migrator
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Data for Name: agent_credentials; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.agent_credentials (id, organization_id, agent_id, kind, token_hash, created_at, revoked_at) FROM stdin;
\.


--
-- Data for Name: agent_limit_notices; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.agent_limit_notices (organization_id, agent_id, conversation_id, day) FROM stdin;
\.


--
-- Data for Name: agent_memories; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.agent_memories (id, organization_id, agent_id, user_id, text, source_event_id, created_at) FROM stdin;
\.


--
-- Data for Name: agent_tool_calls; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.agent_tool_calls (id, organization_id, event_id, agent_id, user_id, tool, source_kind, source_id, target, decision, reason, status, result_count, duration_ms, created_at, completed_at) FROM stdin;
\.


--
-- Data for Name: agent_turns; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id, tools, tool_flags, tool_calls, web_calls, tainted, created_at) FROM stdin;
\.


--
-- Data for Name: agent_usage_daily; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.agent_usage_daily (organization_id, agent_id, day, turns) FROM stdin;
\.


--
-- Data for Name: agents; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.agents (id, organization_id, name, username, avatar_url, description, instructions, model_provider, model_id, runtime, status, status_message, runtime_ref, created_by, created_at, updated_at, deleted_at, scope, owner_user_id, capabilities) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000321	aaaaaaaa-0000-4000-8000-000000000001	Helper Bot	helper-bot	\N	Synthetic team bot for the upgrade test.	Answer briefly.	openai	gpt-upgrade-test	openclaw	ready	\N	{}	aaaaaaaa-0000-4000-8000-000000000101	2026-10-06 09:15:00+00	2026-10-06 09:15:00+00	\N	team	\N	{}
\.


--
-- Data for Name: ai_chat_policies; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.ai_chat_policies (organization_id, chatgpt_plan_enabled, org_keys_enabled, plan_allowed_models, org_key_daily_generations, org_key_daily_cost_micros, plan_daily_generations, concurrent_generations_per_user, max_context_tokens, web_enabled, title_models, chatgpt_host_id, updated_by, updated_at) FROM stdin;
\.


--
-- Data for Name: ai_chat_shares; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.ai_chat_shares (id, organization_id, conversation_id, created_by, title, snapshot, attachment_ids, created_at, revoked_at) FROM stdin;
\.


--
-- Data for Name: ai_chats; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.ai_chats (conversation_id, organization_id, owner_user_id, title_source, instructions, use_personal_instructions, tools, last_model, last_activity_at, created_at, updated_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000203	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000101	user	Be concise.	t	{"web": false}	{"modelId": "gpt-upgrade-test", "provider": "openai"}	2026-10-06 09:23:00+00	2026-10-06 09:22:00+00	2026-10-06 09:23:00+00
\.


--
-- Data for Name: ai_generations; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.ai_generations (id, organization_id, conversation_id, user_message_id, assistant_message_id, requester_user_id, backend, provider, model_id, attempt, status, error_code, error_param, finish_reason, partial_text, instance_id, heartbeat_at, web_used, source_domains, truncated, started_at, finished_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000401	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000203	aaaaaaaa-0000-4000-8000-000000000505	aaaaaaaa-0000-4000-8000-000000000506	aaaaaaaa-0000-4000-8000-000000000101	org_key	openai	gpt-upgrade-test	1	completed	\N	\N	stop	Three migrations and a grant.	upgrade-baseline	2026-10-06 09:34:05+00	f	{}	f	2026-10-06 09:34:01+00	2026-10-06 09:34:05+00
\.


--
-- Data for Name: ai_usage_daily; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.ai_usage_daily (organization_id, user_id, day, backend_class, generations, input_tokens, output_tokens, cost_micros_usd) FROM stdin;
\.


--
-- Data for Name: ai_usage_records; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.ai_usage_records (id, organization_id, generation_id, kind, requester_user_id, conversation_id, message_id, backend, provider, model_id, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, estimated, cost_micros_usd, price_ref, created_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000411	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000401	chat	aaaaaaaa-0000-4000-8000-000000000101	aaaaaaaa-0000-4000-8000-000000000203	aaaaaaaa-0000-4000-8000-000000000506	org_key	openai	gpt-upgrade-test	12	7	\N	\N	f	42	test-price-ref	2026-10-06 09:34:05+00
\.


--
-- Data for Name: ai_user_preferences; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.ai_user_preferences (organization_id, user_id, instructions, default_model, web_default, updated_at) FROM stdin;
\.


--
-- Data for Name: attachments; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.attachments (id, organization_id, conversation_id, message_id, uploader_id, filename, declared_type, content_type, size_bytes, sha256, status, scan_status, width, height, has_renditions, created_at, completed_at, deleted_at, purged_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000601	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000201	aaaaaaaa-0000-4000-8000-000000000502	aaaaaaaa-0000-4000-8000-000000000102	diagram.png	image/png	image/png	2048	0000000000000000000000000000000000000000000000000000000000000000	ready	not_scanned	64	32	f	2026-10-06 09:30:20+00	2026-10-06 09:30:25+00	\N	\N
\.


--
-- Data for Name: audit_events; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.audit_events (id, organization_id, occurred_at, actor_kind, actor_id, agent_id, user_id, device_id, session_id, client_kind, resource_type, resource_id, action, result, metadata, trace_id) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000611	aaaaaaaa-0000-4000-8000-000000000001	2026-10-06 09:10:00+00	user	aaaaaaaa-0000-4000-8000-000000000101	\N	aaaaaaaa-0000-4000-8000-000000000101	\N	\N	\N	secret	aaaaaaaa-0000-4000-8000-000000000301	secret.created	success	{"kind": "provider_api_key", "name": "openai-api-key", "provider": "openai"}	\N
aaaaaaaa-0000-4000-8000-000000000612	aaaaaaaa-0000-4000-8000-000000000001	2026-10-06 09:15:00+00	user	aaaaaaaa-0000-4000-8000-000000000101	\N	aaaaaaaa-0000-4000-8000-000000000101	\N	\N	\N	agent	aaaaaaaa-0000-4000-8000-000000000321	agent.created	success	{}	\N
bbbbbbbb-0000-4000-8000-000000000611	bbbbbbbb-0000-4000-8000-000000000001	2026-10-06 09:20:00+00	user	bbbbbbbb-0000-4000-8000-000000000101	\N	bbbbbbbb-0000-4000-8000-000000000101	\N	\N	\N	conversation	bbbbbbbb-0000-4000-8000-000000000201	channel.created	success	{}	\N
\.


--
-- Data for Name: bot_policies; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.bot_policies (organization_id, capabilities, search_provider, max_personal_bots_per_user, personal_daily_limit_max, personal_allowed_models, updated_by, updated_at) FROM stdin;
\.


--
-- Data for Name: bot_tool_grants; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.bot_tool_grants (organization_id, agent_id, source_kind, source_id, tool_name, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: cell_plugin_tools; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.cell_plugin_tools (organization_id, plugin_row_id, name, description, side_effecting) FROM stdin;
\.


--
-- Data for Name: cell_plugins; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.cell_plugins (id, organization_id, package_name, plugin_id, version, channel, publisher, artifact_sha256, npm_integrity, artifact_url, risk, risk_reasons, declared, status, status_detail, org_enabled, personal_allowed, trusted_chaining, flow_id, approved_by, approved_at, installed_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: conversation_members; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.conversation_members (conversation_id, organization_id, member_kind, member_id, role, created_at, last_read_seq, notify_level, muted) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000201	aaaaaaaa-0000-4000-8000-000000000001	user	aaaaaaaa-0000-4000-8000-000000000101	owner	2026-10-06 09:20:00+00	3	default	f
aaaaaaaa-0000-4000-8000-000000000201	aaaaaaaa-0000-4000-8000-000000000001	user	aaaaaaaa-0000-4000-8000-000000000102	member	2026-10-06 09:20:00+00	2	default	f
aaaaaaaa-0000-4000-8000-000000000201	aaaaaaaa-0000-4000-8000-000000000001	agent	aaaaaaaa-0000-4000-8000-000000000321	member	2026-10-06 09:20:00+00	0	default	f
aaaaaaaa-0000-4000-8000-000000000202	aaaaaaaa-0000-4000-8000-000000000001	user	aaaaaaaa-0000-4000-8000-000000000101	member	2026-10-06 09:21:00+00	1	default	f
aaaaaaaa-0000-4000-8000-000000000202	aaaaaaaa-0000-4000-8000-000000000001	user	aaaaaaaa-0000-4000-8000-000000000102	member	2026-10-06 09:21:00+00	0	default	f
aaaaaaaa-0000-4000-8000-000000000203	aaaaaaaa-0000-4000-8000-000000000001	user	aaaaaaaa-0000-4000-8000-000000000101	owner	2026-10-06 09:22:00+00	2	default	f
bbbbbbbb-0000-4000-8000-000000000201	bbbbbbbb-0000-4000-8000-000000000001	user	bbbbbbbb-0000-4000-8000-000000000101	owner	2026-10-06 09:20:00+00	1	default	f
\.


--
-- Data for Name: conversations; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.conversations (id, organization_id, kind, name, slug, topic, visibility, parent_conversation_id, root_message_id, created_by, archived_at, created_at, dm_key, unit_id) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000201	aaaaaaaa-0000-4000-8000-000000000001	channel	general	general	Upgrade test channel	public	\N	\N	aaaaaaaa-0000-4000-8000-000000000101	\N	2026-10-06 09:20:00+00	\N	\N
aaaaaaaa-0000-4000-8000-000000000202	aaaaaaaa-0000-4000-8000-000000000001	dm	\N	\N	\N	private	\N	\N	aaaaaaaa-0000-4000-8000-000000000101	\N	2026-10-06 09:21:00+00	user:aaaaaaaa-0000-4000-8000-000000000101|user:aaaaaaaa-0000-4000-8000-000000000102	\N
aaaaaaaa-0000-4000-8000-000000000203	aaaaaaaa-0000-4000-8000-000000000001	ai_chat	Upgrade checklist	\N	\N	private	\N	\N	aaaaaaaa-0000-4000-8000-000000000101	\N	2026-10-06 09:22:00+00	\N	\N
bbbbbbbb-0000-4000-8000-000000000201	bbbbbbbb-0000-4000-8000-000000000001	channel	general	general	\N	public	\N	\N	bbbbbbbb-0000-4000-8000-000000000101	\N	2026-10-06 09:20:00+00	\N	\N
\.


--
-- Data for Name: device_commands; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.device_commands (id, organization_id, device_id, work_session_id, kind, payload, status, error, created_at, sent_at, acked_at) FROM stdin;
\.


--
-- Data for Name: device_enrollments; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.device_enrollments (code_hash, organization_id, user_id, expires_at, consumed_at, created_at) FROM stdin;
\.


--
-- Data for Name: device_grants; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.device_grants (organization_id, device_id, principal_kind, principal_id, max_mode, created_by, created_at, revoked_at, revoked_by) FROM stdin;
\.


--
-- Data for Name: devices; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.devices (id, organization_id, owner_user_id, name, platform, token_hash, status, last_seen_at, runtime_info, revoked_at, created_at, daemon_version, shared, full_access_opt_in, share_max_mode, runtime_catalog) FROM stdin;
\.


--
-- Data for Name: mcp_server_tools; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.mcp_server_tools (organization_id, server_id, name, openclaw_name, title, description, read_only, destructive) FROM stdin;
\.


--
-- Data for Name: mcp_servers; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.mcp_servers (id, organization_id, name, safe_name, transport, url, sandbox_server, headers, org_enabled, personal_allowed, trusted_chaining, status, status_detail, probed_at, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: message_pins; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.message_pins (organization_id, conversation_id, message_id, pinned_by, created_at) FROM stdin;
\.


--
-- Data for Name: message_reactions; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.message_reactions (organization_id, message_id, conversation_id, emoji, member_kind, member_id, created_at) FROM stdin;
\.


--
-- Data for Name: message_saves; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.message_saves (organization_id, user_id, message_id, created_at) FROM stdin;
\.


--
-- Data for Name: message_versions; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.message_versions (id, organization_id, message_id, version, kind, body, mentions, edited_by_kind, edited_by, created_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000511	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000502	1	edit	Diagram attached	[]	user	aaaaaaaa-0000-4000-8000-000000000102	2026-10-06 09:32:00+00
\.


--
-- Data for Name: messages; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.messages (id, organization_id, conversation_id, seq, author_kind, author_id, body, mentions, status, thread_id, reply_count, last_reply_at, client_kind, session_id, client_message_id, created_at, edited_at, deleted_at, deleted_by) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000501	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000201	1	user	aaaaaaaa-0000-4000-8000-000000000101	Welcome to the upgrade test channel	[]	sent	\N	1	2026-10-06 09:31:00+00	web	\N	\N	2026-10-06 09:30:00+00	\N	\N	\N
aaaaaaaa-0000-4000-8000-000000000502	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000201	2	user	aaaaaaaa-0000-4000-8000-000000000102	Diagram attached (edited)	[]	sent	\N	0	\N	web	\N	\N	2026-10-06 09:30:30+00	2026-10-06 09:32:00+00	\N	\N
aaaaaaaa-0000-4000-8000-000000000503	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000201	3	user	aaaaaaaa-0000-4000-8000-000000000102	Thread reply: thanks!	[]	sent	aaaaaaaa-0000-4000-8000-000000000501	0	\N	web	\N	\N	2026-10-06 09:31:00+00	\N	\N	\N
aaaaaaaa-0000-4000-8000-000000000504	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000202	1	user	aaaaaaaa-0000-4000-8000-000000000101	Private hello	[]	sent	\N	0	\N	web	\N	\N	2026-10-06 09:33:00+00	\N	\N	\N
aaaaaaaa-0000-4000-8000-000000000505	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000203	1	user	aaaaaaaa-0000-4000-8000-000000000101	What changes in this upgrade?	[]	sent	\N	0	\N	web	\N	\N	2026-10-06 09:34:00+00	\N	\N	\N
aaaaaaaa-0000-4000-8000-000000000506	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000203	2	agent	\N	Three migrations and a grant.	[]	completed	\N	0	\N	\N	\N	\N	2026-10-06 09:34:05+00	\N	\N	\N
bbbbbbbb-0000-4000-8000-000000000501	bbbbbbbb-0000-4000-8000-000000000001	bbbbbbbb-0000-4000-8000-000000000201	1	user	bbbbbbbb-0000-4000-8000-000000000101	Beta only: never visible to Acme	[]	sent	\N	0	\N	web	\N	\N	2026-10-06 09:30:00+00	\N	\N	\N
\.


--
-- Data for Name: model_providers; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.model_providers (id, organization_id, provider, secret_id, allowed_models, enabled, created_at, key_hint, base_url, updated_at, account, secret_ref) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000311	aaaaaaaa-0000-4000-8000-000000000001	openai	aaaaaaaa-0000-4000-8000-000000000301	{gpt-upgrade-test}	t	2026-10-06 09:10:00+00	…-key	\N	2026-10-06 09:10:00+00	\N	{"provider": "db", "secretId": "aaaaaaaa-0000-4000-8000-000000000301", "organizationId": "aaaaaaaa-0000-4000-8000-000000000001"}
\.


--
-- Data for Name: notification_prefs; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.notification_prefs (organization_id, user_id, dnd_until, desktop_enabled, web_enabled, default_level, updated_at) FROM stdin;
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.notifications (id, organization_id, user_id, kind, conversation_id, message_id, thread_root_id, actor_kind, actor_id, created_at, read_at) FROM stdin;
\.


--
-- Data for Name: org_members; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.org_members (id, organization_id, user_id, display_name, email, avatar_url, role, created_at, status_emoji, status_text, deactivated_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000131	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000101	Ada Admin	ada.admin@acme.test	\N	admin	2026-10-06 09:00:00+00	\N	\N	\N
aaaaaaaa-0000-4000-8000-000000000132	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000102	Max Member	max.member@acme.test	\N	developer	2026-10-06 09:05:00+00	\N	\N	\N
bbbbbbbb-0000-4000-8000-000000000131	bbbbbbbb-0000-4000-8000-000000000001	bbbbbbbb-0000-4000-8000-000000000101	Bea Admin	bea.admin@beta.test	\N	admin	2026-10-06 09:00:00+00	\N	\N	\N
\.


--
-- Data for Name: org_units; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.org_units (id, organization_id, parent_id, kind, name, path, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: permission_rules; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.permission_rules (id, organization_id, scope_unit_id, subject_kind, subject_id, permission, tool, effect, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: projects; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.projects (id, organization_id, device_id, local_id, name, git_remote, default_branch, created_by, created_at, removed_at) FROM stdin;
\.


--
-- Data for Name: secrets; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.secrets (id, organization_id, name, kind, provider, ciphertext, iv, tag, created_by, created_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000301	aaaaaaaa-0000-4000-8000-000000000001	openai-api-key	provider_api_key	openai	U8B19hkytroO0aV/Yh5xf2DbMRNVn1DOdTgbZoZhtG0tdS/0rw==	SelU/E7aj963X6Mi	MmWJ6JkueFSJZPefcZNvtQ==	aaaaaaaa-0000-4000-8000-000000000101	2026-10-06 09:10:00+00
\.


--
-- Data for Name: stream_events; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.stream_events (stream_id, seq, organization_id, type, payload, actor_user_id, created_at) FROM stdin;
conv:aaaaaaaa-0000-4000-8000-000000000201	1	aaaaaaaa-0000-4000-8000-000000000001	message.created	{"messageId": "aaaaaaaa-0000-4000-8000-000000000501"}	aaaaaaaa-0000-4000-8000-000000000101	2026-10-06 09:30:00+00
conv:aaaaaaaa-0000-4000-8000-000000000201	2	aaaaaaaa-0000-4000-8000-000000000001	message.created	{"messageId": "aaaaaaaa-0000-4000-8000-000000000502"}	aaaaaaaa-0000-4000-8000-000000000102	2026-10-06 09:30:30+00
conv:aaaaaaaa-0000-4000-8000-000000000201	3	aaaaaaaa-0000-4000-8000-000000000001	message.created	{"messageId": "aaaaaaaa-0000-4000-8000-000000000503"}	aaaaaaaa-0000-4000-8000-000000000102	2026-10-06 09:31:00+00
conv:bbbbbbbb-0000-4000-8000-000000000201	1	bbbbbbbb-0000-4000-8000-000000000001	message.created	{"messageId": "bbbbbbbb-0000-4000-8000-000000000501"}	bbbbbbbb-0000-4000-8000-000000000101	2026-10-06 09:30:00+00
\.


--
-- Data for Name: streams; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.streams (id, organization_id, last_seq) FROM stdin;
conv:aaaaaaaa-0000-4000-8000-000000000201	aaaaaaaa-0000-4000-8000-000000000001	3
conv:bbbbbbbb-0000-4000-8000-000000000201	bbbbbbbb-0000-4000-8000-000000000001	1
\.


--
-- Data for Name: thread_reads; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.thread_reads (organization_id, user_id, root_message_id, last_read_seq, updated_at) FROM stdin;
\.


--
-- Data for Name: unit_memberships; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.unit_memberships (organization_id, unit_id, user_id, role, added_by, created_at) FROM stdin;
\.


--
-- Data for Name: user_model_credentials; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.user_model_credentials (id, organization_id, user_id, provider, secret_id, issued_client_id, subject, email, plan_type, scopes, access_expires_at, status, last_error, welcome_seen_at, connected_at, updated_at) FROM stdin;
\.


--
-- Data for Name: work_approvals; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.work_approvals (id, organization_id, work_session_id, request, status, decided_by, decision, comment, created_at, decided_at) FROM stdin;
\.


--
-- Data for Name: work_prompts; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.work_prompts (id, organization_id, work_session_id, author_user_id, origin_device_id, body, status, "position", created_at, dispatched_at, completed_at, permission_mode) FROM stdin;
\.


--
-- Data for Name: work_sessions; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.work_sessions (id, organization_id, conversation_id, project_id, device_id, runtime, model, permission_mode, status, title, created_by, runtime_session_id, created_at, updated_at, worktree, branch, last_local_seq, last_error, settings, effective_settings, settings_pending, diff_stat, title_source) FROM stdin;
\.


--
-- Data for Name: work_zone_policies; Type: TABLE DATA; Schema: app; Owner: ocw_migrator
--

COPY app.work_zone_policies (organization_id, allowed_permission_modes, allow_full_access, allowed_models, max_effort, allow_fast_mode, updated_by, updated_at) FROM stdin;
\.


--
-- Data for Name: account; Type: TABLE DATA; Schema: auth; Owner: ocw_migrator
--

COPY auth.account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000111	aaaaaaaa-0000-4000-8000-000000000101	credential	aaaaaaaa-0000-4000-8000-000000000101	\N	\N	\N	\N	\N	\N	fake-password-hash-not-a-real-credential	2026-10-06 09:00:00+00	2026-10-06 09:00:00+00
aaaaaaaa-0000-4000-8000-000000000112	aaaaaaaa-0000-4000-8000-000000000102	credential	aaaaaaaa-0000-4000-8000-000000000102	\N	\N	\N	\N	\N	\N	fake-password-hash-not-a-real-credential	2026-10-06 09:05:00+00	2026-10-06 09:05:00+00
bbbbbbbb-0000-4000-8000-000000000111	bbbbbbbb-0000-4000-8000-000000000101	credential	bbbbbbbb-0000-4000-8000-000000000101	\N	\N	\N	\N	\N	\N	fake-password-hash-not-a-real-credential	2026-10-06 09:00:00+00	2026-10-06 09:00:00+00
\.


--
-- Data for Name: instance_setup; Type: TABLE DATA; Schema: auth; Owner: ocw_migrator
--

COPY auth.instance_setup (id, singleton, organization_id, redeemed_by, redeemed_at) FROM stdin;
\.


--
-- Data for Name: invitation; Type: TABLE DATA; Schema: auth; Owner: ocw_migrator
--

COPY auth.invitation (id, organization_id, email, role, team_id, status, expires_at, inviter_id, created_at) FROM stdin;
\.


--
-- Data for Name: jwks; Type: TABLE DATA; Schema: auth; Owner: ocw_migrator
--

COPY auth.jwks (id, public_key, private_key, created_at, expires_at, alg, crv) FROM stdin;
\.


--
-- Data for Name: member; Type: TABLE DATA; Schema: auth; Owner: ocw_migrator
--

COPY auth.member (id, organization_id, user_id, role, created_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000121	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000101	member	2026-10-06 09:00:00+00
aaaaaaaa-0000-4000-8000-000000000122	aaaaaaaa-0000-4000-8000-000000000001	aaaaaaaa-0000-4000-8000-000000000102	member	2026-10-06 09:05:00+00
bbbbbbbb-0000-4000-8000-000000000121	bbbbbbbb-0000-4000-8000-000000000001	bbbbbbbb-0000-4000-8000-000000000101	member	2026-10-06 09:00:00+00
\.


--
-- Data for Name: organization; Type: TABLE DATA; Schema: auth; Owner: ocw_migrator
--

COPY auth.organization (id, name, slug, logo, metadata, created_at, updated_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000001	Acme Upgrade Test	acme-upgrade-test	\N	\N	2026-10-06 09:00:00+00	\N
bbbbbbbb-0000-4000-8000-000000000001	Beta Upgrade Test	beta-upgrade-test	\N	\N	2026-10-06 09:00:00+00	\N
\.


--
-- Data for Name: session; Type: TABLE DATA; Schema: auth; Owner: ocw_migrator
--

COPY auth.session (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id, active_organization_id, client_kind, client_label) FROM stdin;
\.


--
-- Data for Name: user; Type: TABLE DATA; Schema: auth; Owner: ocw_migrator
--

COPY auth."user" (id, name, email, email_verified, image, created_at, updated_at) FROM stdin;
aaaaaaaa-0000-4000-8000-000000000101	Ada Admin	ada.admin@acme.test	t	\N	2026-10-06 09:00:00+00	2026-10-06 09:00:00+00
aaaaaaaa-0000-4000-8000-000000000102	Max Member	max.member@acme.test	t	\N	2026-10-06 09:05:00+00	2026-10-06 09:05:00+00
bbbbbbbb-0000-4000-8000-000000000101	Bea Admin	bea.admin@beta.test	t	\N	2026-10-06 09:00:00+00	2026-10-06 09:00:00+00
\.


--
-- Data for Name: verification; Type: TABLE DATA; Schema: auth; Owner: ocw_migrator
--

COPY auth.verification (id, identifier, value, expires_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: __drizzle_migrations; Type: TABLE DATA; Schema: drizzle; Owner: ocw_migrator
--

COPY drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) FROM stdin;
1	56605a3177810ff980630823f9184a79b4c11145abdd8c1e254e7c6fe4bed9fe	1790963455000	20261002175055_init	2026-10-02 17:50:55+00
2	6608bbe9a6bd1f438a0377188733ae6cd0a3038054c6dc159344cae572a34abf	1790965464000	20261002182424_chat_idempotency	2026-10-02 18:24:24+00
3	8016d981bbce9ecbd04680acf89d70e3e735f5986c3b0ee2386339bf11e8a691	1790965608000	20261002182648_agents_bots	2026-10-02 18:26:48+00
4	53513996124feca58b971662a78ff351293bbcbe1cced66e9228b48b525fb6dd	1790965794000	20261002182954_workzone_device_link	2026-10-02 18:29:54+00
5	37eb9a711cfa58127b1f0c947da1e3472b5585aea5219218ffaa1facfc24e7c8	1791125540000	20261004145220_provider_subscription_account	2026-10-04 14:52:20+00
6	bb8e99865a3c1aad49e803990d6d3310ea8b3176581d7c99e60c10984e0270e7	1791139398000	20261004184318_role_values	2026-10-04 18:43:18+00
7	eb3ae37c8cf55efc602fb5197cea62f8d16dcc015c8a8beb3992b48f1bd880fd	1791139420000	20261004184340_role_check	2026-10-04 18:43:40+00
8	6599903dc6aab670b9387fdc030b7001fd027368051746e428549414ab56bab6	1791139459000	20261004184419_identity_org	2026-10-04 18:44:19+00
9	5a8fe707ab40dd96506fe0886dbb09f6399f1d1ccd9f95738aa203b6648ce031	1791161994000	20261005005954_personal_bots_capabilities	2026-10-05 00:59:54+00
10	98337017d4be0ca28585a4317bb90f63fb859b5f6f7d66f59b0bfb106e21ffd8	1791231032000	20261005201032_work_zone_controls	2026-10-05 20:10:32+00
11	2bb01a2c2ed5c686a4ea6f05a3f3f6c756fc660f1000bb5c201e331dc4cd6207	1791250173000	20261006012933_session_title_source	2026-10-06 01:29:33+00
12	cb0b28f1bdc872bdc78facd81de865116b3ec824a55e59eb5ff989117900349c	1791260344000	20261006041904_chat_workspace	2026-10-06 04:19:04+00
13	144104f52509953d12ee7a116304f3c4fd42edad81608be1ea466117d3121806	1791300579000	20261006152939_ai_chat	2026-10-06 15:29:39+00
14	c33f00604dd6acbdabffc21061c53f8288b7f70949280c2809028073813b9c6b	1791300677000	20261006153117_provider_secret_refs	2026-10-06 15:31:17+00
\.


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: ocw_migrator
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 14, true);


--
-- Name: agent_credentials agent_credentials_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_credentials
    ADD CONSTRAINT agent_credentials_pkey PRIMARY KEY (id);


--
-- Name: agent_credentials agent_credentials_token_hash_key; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_credentials
    ADD CONSTRAINT agent_credentials_token_hash_key UNIQUE (token_hash);


--
-- Name: agent_limit_notices agent_limit_notices_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_limit_notices
    ADD CONSTRAINT agent_limit_notices_pkey PRIMARY KEY (agent_id, conversation_id, day);


--
-- Name: agent_memories agent_memories_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_memories
    ADD CONSTRAINT agent_memories_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_calls agent_tool_calls_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_pkey PRIMARY KEY (id);


--
-- Name: agent_turns agent_turns_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_turns
    ADD CONSTRAINT agent_turns_pkey PRIMARY KEY (event_id);


--
-- Name: agent_usage_daily agent_usage_daily_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_usage_daily
    ADD CONSTRAINT agent_usage_daily_pkey PRIMARY KEY (organization_id, agent_id, day);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: ai_chat_policies ai_chat_policies_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_chat_policies
    ADD CONSTRAINT ai_chat_policies_pkey PRIMARY KEY (organization_id);


--
-- Name: ai_chat_shares ai_chat_shares_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_chat_shares
    ADD CONSTRAINT ai_chat_shares_pkey PRIMARY KEY (id);


--
-- Name: ai_chats ai_chats_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_chats
    ADD CONSTRAINT ai_chats_pkey PRIMARY KEY (conversation_id);


--
-- Name: ai_generations ai_generations_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_generations
    ADD CONSTRAINT ai_generations_pkey PRIMARY KEY (id);


--
-- Name: ai_usage_daily ai_usage_daily_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_usage_daily
    ADD CONSTRAINT ai_usage_daily_pkey PRIMARY KEY (organization_id, user_id, day, backend_class);


--
-- Name: ai_usage_records ai_usage_records_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_usage_records
    ADD CONSTRAINT ai_usage_records_pkey PRIMARY KEY (id);


--
-- Name: ai_user_preferences ai_user_preferences_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_user_preferences
    ADD CONSTRAINT ai_user_preferences_pkey PRIMARY KEY (organization_id, user_id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: bot_policies bot_policies_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.bot_policies
    ADD CONSTRAINT bot_policies_pkey PRIMARY KEY (organization_id);


--
-- Name: bot_tool_grants bot_tool_grants_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.bot_tool_grants
    ADD CONSTRAINT bot_tool_grants_pkey PRIMARY KEY (agent_id, source_kind, source_id, tool_name);


--
-- Name: cell_plugin_tools cell_plugin_tools_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.cell_plugin_tools
    ADD CONSTRAINT cell_plugin_tools_pkey PRIMARY KEY (plugin_row_id, name);


--
-- Name: cell_plugins cell_plugins_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.cell_plugins
    ADD CONSTRAINT cell_plugins_pkey PRIMARY KEY (id);


--
-- Name: conversation_members conversation_members_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.conversation_members
    ADD CONSTRAINT conversation_members_pkey PRIMARY KEY (conversation_id, member_kind, member_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: device_commands device_commands_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.device_commands
    ADD CONSTRAINT device_commands_pkey PRIMARY KEY (id);


--
-- Name: device_enrollments device_enrollments_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.device_enrollments
    ADD CONSTRAINT device_enrollments_pkey PRIMARY KEY (code_hash);


--
-- Name: device_grants device_grants_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.device_grants
    ADD CONSTRAINT device_grants_pkey PRIMARY KEY (device_id, principal_kind, principal_id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: devices devices_token_hash_key; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.devices
    ADD CONSTRAINT devices_token_hash_key UNIQUE (token_hash);


--
-- Name: mcp_server_tools mcp_server_tools_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.mcp_server_tools
    ADD CONSTRAINT mcp_server_tools_pkey PRIMARY KEY (server_id, name);


--
-- Name: mcp_servers mcp_servers_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);


--
-- Name: message_pins message_pins_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_pins
    ADD CONSTRAINT message_pins_pkey PRIMARY KEY (conversation_id, message_id);


--
-- Name: message_reactions message_reactions_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_reactions
    ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (message_id, emoji, member_kind, member_id);


--
-- Name: message_saves message_saves_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_saves
    ADD CONSTRAINT message_saves_pkey PRIMARY KEY (user_id, message_id);


--
-- Name: message_versions message_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_versions
    ADD CONSTRAINT message_versions_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: model_providers model_providers_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.model_providers
    ADD CONSTRAINT model_providers_pkey PRIMARY KEY (id);


--
-- Name: notification_prefs notification_prefs_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.notification_prefs
    ADD CONSTRAINT notification_prefs_pkey PRIMARY KEY (organization_id, user_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: org_members org_members_id_key; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.org_members
    ADD CONSTRAINT org_members_id_key UNIQUE (id);


--
-- Name: org_members org_members_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.org_members
    ADD CONSTRAINT org_members_pkey PRIMARY KEY (organization_id, user_id);


--
-- Name: org_units org_units_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.org_units
    ADD CONSTRAINT org_units_pkey PRIMARY KEY (id);


--
-- Name: permission_rules permission_rules_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.permission_rules
    ADD CONSTRAINT permission_rules_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: secrets secrets_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (id);


--
-- Name: stream_events stream_events_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.stream_events
    ADD CONSTRAINT stream_events_pkey PRIMARY KEY (stream_id, seq);


--
-- Name: streams streams_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.streams
    ADD CONSTRAINT streams_pkey PRIMARY KEY (id);


--
-- Name: thread_reads thread_reads_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.thread_reads
    ADD CONSTRAINT thread_reads_pkey PRIMARY KEY (user_id, root_message_id);


--
-- Name: unit_memberships unit_memberships_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.unit_memberships
    ADD CONSTRAINT unit_memberships_pkey PRIMARY KEY (unit_id, user_id);


--
-- Name: user_model_credentials user_model_credentials_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.user_model_credentials
    ADD CONSTRAINT user_model_credentials_pkey PRIMARY KEY (id);


--
-- Name: work_approvals work_approvals_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_approvals
    ADD CONSTRAINT work_approvals_pkey PRIMARY KEY (id);


--
-- Name: work_prompts work_prompts_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_prompts
    ADD CONSTRAINT work_prompts_pkey PRIMARY KEY (id);


--
-- Name: work_sessions work_sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_sessions
    ADD CONSTRAINT work_sessions_pkey PRIMARY KEY (id);


--
-- Name: work_zone_policies work_zone_policies_pkey; Type: CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_zone_policies
    ADD CONSTRAINT work_zone_policies_pkey PRIMARY KEY (organization_id);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: instance_setup instance_setup_pkey; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.instance_setup
    ADD CONSTRAINT instance_setup_pkey PRIMARY KEY (id);


--
-- Name: instance_setup instance_setup_singleton_key; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.instance_setup
    ADD CONSTRAINT instance_setup_singleton_key UNIQUE (singleton);


--
-- Name: invitation invitation_pkey; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.invitation
    ADD CONSTRAINT invitation_pkey PRIMARY KEY (id);


--
-- Name: jwks jwks_pkey; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);


--
-- Name: member member_pkey; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_key; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.organization
    ADD CONSTRAINT organization_slug_key UNIQUE (slug);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: ocw_migrator
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: agent_credentials_org_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX agent_credentials_org_idx ON app.agent_credentials USING btree (organization_id);


--
-- Name: agent_memories_owner_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX agent_memories_owner_idx ON app.agent_memories USING btree (organization_id, agent_id, user_id, created_at);


--
-- Name: agent_tool_calls_org_event_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX agent_tool_calls_org_event_idx ON app.agent_tool_calls USING btree (organization_id, event_id);


--
-- Name: agent_turns_org_agent_time_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX agent_turns_org_agent_time_idx ON app.agent_turns USING btree (organization_id, agent_id, created_at);


--
-- Name: agents_name_trgm; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX agents_name_trgm ON app.agents USING gin (name app.gin_trgm_ops);


--
-- Name: agents_org_username_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX agents_org_username_uq ON app.agents USING btree (organization_id, username) WHERE (deleted_at IS NULL);


--
-- Name: agents_owner_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX agents_owner_idx ON app.agents USING btree (organization_id, owner_user_id) WHERE ((scope = 'personal'::text) AND (deleted_at IS NULL));


--
-- Name: ai_chat_shares_conversation_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX ai_chat_shares_conversation_idx ON app.ai_chat_shares USING btree (organization_id, conversation_id);


--
-- Name: ai_chats_owner_activity_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX ai_chats_owner_activity_idx ON app.ai_chats USING btree (organization_id, owner_user_id, last_activity_at);


--
-- Name: ai_generations_assistant_message_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX ai_generations_assistant_message_idx ON app.ai_generations USING btree (organization_id, assistant_message_id);


--
-- Name: ai_generations_heartbeat_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX ai_generations_heartbeat_idx ON app.ai_generations USING btree (heartbeat_at) WHERE (status = 'running'::text);


--
-- Name: ai_generations_one_running_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX ai_generations_one_running_uq ON app.ai_generations USING btree (conversation_id) WHERE (status = 'running'::text);


--
-- Name: ai_generations_requester_started_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX ai_generations_requester_started_idx ON app.ai_generations USING btree (organization_id, requester_user_id, started_at);


--
-- Name: ai_usage_records_generation_kind_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX ai_usage_records_generation_kind_uq ON app.ai_usage_records USING btree (generation_id, kind);


--
-- Name: ai_usage_records_org_time_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX ai_usage_records_org_time_idx ON app.ai_usage_records USING btree (organization_id, created_at);


--
-- Name: ai_usage_records_requester_time_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX ai_usage_records_requester_time_idx ON app.ai_usage_records USING btree (organization_id, requester_user_id, created_at);


--
-- Name: attachments_org_conv_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX attachments_org_conv_idx ON app.attachments USING btree (organization_id, conversation_id);


--
-- Name: attachments_org_message_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX attachments_org_message_idx ON app.attachments USING btree (organization_id, message_id);


--
-- Name: attachments_sweep_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX attachments_sweep_idx ON app.attachments USING btree (status, created_at) WHERE ((purged_at IS NULL) AND (status = ANY (ARRAY['pending'::text, 'rejected'::text, 'deleted'::text])));


--
-- Name: audit_events_org_time_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX audit_events_org_time_idx ON app.audit_events USING btree (organization_id, occurred_at);


--
-- Name: cell_plugins_org_package_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX cell_plugins_org_package_uq ON app.cell_plugins USING btree (organization_id, package_name) WHERE (status <> 'uninstalled'::text);


--
-- Name: conversation_members_member_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX conversation_members_member_idx ON app.conversation_members USING btree (organization_id, member_kind, member_id);


--
-- Name: conversations_name_trgm; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX conversations_name_trgm ON app.conversations USING gin (name app.gin_trgm_ops);


--
-- Name: conversations_org_dm_key_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX conversations_org_dm_key_uq ON app.conversations USING btree (organization_id, dm_key) WHERE (kind = 'dm'::text);


--
-- Name: conversations_org_group_key_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX conversations_org_group_key_uq ON app.conversations USING btree (organization_id, dm_key) WHERE (kind = 'group'::text);


--
-- Name: conversations_org_kind_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX conversations_org_kind_idx ON app.conversations USING btree (organization_id, kind);


--
-- Name: conversations_org_slug_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX conversations_org_slug_uq ON app.conversations USING btree (organization_id, slug) WHERE ((kind = 'channel'::text) AND (slug IS NOT NULL));


--
-- Name: conversations_org_unit_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX conversations_org_unit_idx ON app.conversations USING btree (organization_id, unit_id);


--
-- Name: conversations_thread_root_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX conversations_thread_root_uq ON app.conversations USING btree (organization_id, root_message_id) WHERE (root_message_id IS NOT NULL);


--
-- Name: device_commands_device_status_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX device_commands_device_status_idx ON app.device_commands USING btree (organization_id, device_id, status, created_at);


--
-- Name: device_enrollments_org_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX device_enrollments_org_idx ON app.device_enrollments USING btree (organization_id);


--
-- Name: device_grants_principal_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX device_grants_principal_idx ON app.device_grants USING btree (organization_id, principal_kind, principal_id);


--
-- Name: devices_org_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX devices_org_idx ON app.devices USING btree (organization_id);


--
-- Name: mcp_servers_org_safe_name_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX mcp_servers_org_safe_name_uq ON app.mcp_servers USING btree (organization_id, safe_name);


--
-- Name: message_reactions_org_conv_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX message_reactions_org_conv_idx ON app.message_reactions USING btree (organization_id, conversation_id);


--
-- Name: message_saves_org_user_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX message_saves_org_user_idx ON app.message_saves USING btree (organization_id, user_id, created_at);


--
-- Name: message_versions_message_version_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX message_versions_message_version_uq ON app.message_versions USING btree (message_id, version);


--
-- Name: message_versions_org_message_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX message_versions_org_message_idx ON app.message_versions USING btree (organization_id, message_id);


--
-- Name: messages_author_client_msg_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX messages_author_client_msg_uq ON app.messages USING btree (organization_id, author_kind, author_id, client_message_id) WHERE (client_message_id IS NOT NULL);


--
-- Name: messages_conv_seq_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX messages_conv_seq_idx ON app.messages USING btree (organization_id, conversation_id, seq);


--
-- Name: messages_search_gin; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX messages_search_gin ON app.messages USING gin (search_tsv);


--
-- Name: messages_thread_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX messages_thread_idx ON app.messages USING btree (organization_id, thread_id);


--
-- Name: model_providers_org_provider_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX model_providers_org_provider_uq ON app.model_providers USING btree (organization_id, provider);


--
-- Name: notifications_org_user_created_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX notifications_org_user_created_idx ON app.notifications USING btree (organization_id, user_id, created_at);


--
-- Name: notifications_unread_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX notifications_unread_idx ON app.notifications USING btree (organization_id, user_id, conversation_id) WHERE (read_at IS NULL);


--
-- Name: notifications_user_message_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX notifications_user_message_uq ON app.notifications USING btree (user_id, message_id);


--
-- Name: org_members_name_trgm; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX org_members_name_trgm ON app.org_members USING gin (display_name app.gin_trgm_ops);


--
-- Name: org_units_parent_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX org_units_parent_idx ON app.org_units USING btree (organization_id, parent_id);


--
-- Name: org_units_path_gin; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX org_units_path_gin ON app.org_units USING gin (path);


--
-- Name: org_units_sibling_name_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX org_units_sibling_name_uq ON app.org_units USING btree (organization_id, parent_id, lower(name)) NULLS NOT DISTINCT;


--
-- Name: permission_rules_org_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX permission_rules_org_idx ON app.permission_rules USING btree (organization_id);


--
-- Name: projects_device_local_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX projects_device_local_uq ON app.projects USING btree (device_id, local_id);


--
-- Name: secrets_org_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX secrets_org_idx ON app.secrets USING btree (organization_id);


--
-- Name: stream_events_org_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX stream_events_org_idx ON app.stream_events USING btree (organization_id);


--
-- Name: streams_org_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX streams_org_idx ON app.streams USING btree (organization_id);


--
-- Name: unit_memberships_user_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX unit_memberships_user_idx ON app.unit_memberships USING btree (organization_id, user_id);


--
-- Name: user_model_credentials_org_user_provider_uq; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE UNIQUE INDEX user_model_credentials_org_user_provider_uq ON app.user_model_credentials USING btree (organization_id, user_id, provider);


--
-- Name: work_approvals_session_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX work_approvals_session_idx ON app.work_approvals USING btree (organization_id, work_session_id);


--
-- Name: work_prompts_session_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX work_prompts_session_idx ON app.work_prompts USING btree (organization_id, work_session_id, "position");


--
-- Name: work_sessions_org_idx; Type: INDEX; Schema: app; Owner: ocw_migrator
--

CREATE INDEX work_sessions_org_idx ON app.work_sessions USING btree (organization_id, project_id);


--
-- Name: account_user_idx; Type: INDEX; Schema: auth; Owner: ocw_migrator
--

CREATE INDEX account_user_idx ON auth.account USING btree (user_id);


--
-- Name: invitation_org_idx; Type: INDEX; Schema: auth; Owner: ocw_migrator
--

CREATE INDEX invitation_org_idx ON auth.invitation USING btree (organization_id);


--
-- Name: member_org_user_uq; Type: INDEX; Schema: auth; Owner: ocw_migrator
--

CREATE UNIQUE INDEX member_org_user_uq ON auth.member USING btree (organization_id, user_id);


--
-- Name: session_user_idx; Type: INDEX; Schema: auth; Owner: ocw_migrator
--

CREATE INDEX session_user_idx ON auth.session USING btree (user_id);


--
-- Name: agent_credentials agent_credentials_agent_id_agents_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_credentials
    ADD CONSTRAINT agent_credentials_agent_id_agents_id_fkey FOREIGN KEY (agent_id) REFERENCES app.agents(id) ON DELETE CASCADE;


--
-- Name: agent_credentials agent_credentials_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_credentials
    ADD CONSTRAINT agent_credentials_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: agent_limit_notices agent_limit_notices_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_limit_notices
    ADD CONSTRAINT agent_limit_notices_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: agent_memories agent_memories_agent_id_agents_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_memories
    ADD CONSTRAINT agent_memories_agent_id_agents_id_fkey FOREIGN KEY (agent_id) REFERENCES app.agents(id) ON DELETE CASCADE;


--
-- Name: agent_memories agent_memories_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_memories
    ADD CONSTRAINT agent_memories_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: agent_tool_calls agent_tool_calls_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: agent_turns agent_turns_agent_id_agents_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_turns
    ADD CONSTRAINT agent_turns_agent_id_agents_id_fkey FOREIGN KEY (agent_id) REFERENCES app.agents(id) ON DELETE CASCADE;


--
-- Name: agent_turns agent_turns_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_turns
    ADD CONSTRAINT agent_turns_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: agent_usage_daily agent_usage_daily_agent_id_agents_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_usage_daily
    ADD CONSTRAINT agent_usage_daily_agent_id_agents_id_fkey FOREIGN KEY (agent_id) REFERENCES app.agents(id) ON DELETE CASCADE;


--
-- Name: agent_usage_daily agent_usage_daily_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agent_usage_daily
    ADD CONSTRAINT agent_usage_daily_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: agents agents_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.agents
    ADD CONSTRAINT agents_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: ai_chat_policies ai_chat_policies_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_chat_policies
    ADD CONSTRAINT ai_chat_policies_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: ai_chat_shares ai_chat_shares_conversation_id_conversations_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_chat_shares
    ADD CONSTRAINT ai_chat_shares_conversation_id_conversations_id_fkey FOREIGN KEY (conversation_id) REFERENCES app.conversations(id) ON DELETE CASCADE;


--
-- Name: ai_chat_shares ai_chat_shares_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_chat_shares
    ADD CONSTRAINT ai_chat_shares_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: ai_chats ai_chats_conversation_id_conversations_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_chats
    ADD CONSTRAINT ai_chats_conversation_id_conversations_id_fkey FOREIGN KEY (conversation_id) REFERENCES app.conversations(id) ON DELETE CASCADE;


--
-- Name: ai_chats ai_chats_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_chats
    ADD CONSTRAINT ai_chats_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: ai_generations ai_generations_assistant_message_id_messages_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_generations
    ADD CONSTRAINT ai_generations_assistant_message_id_messages_id_fkey FOREIGN KEY (assistant_message_id) REFERENCES app.messages(id) ON DELETE CASCADE;


--
-- Name: ai_generations ai_generations_conversation_id_conversations_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_generations
    ADD CONSTRAINT ai_generations_conversation_id_conversations_id_fkey FOREIGN KEY (conversation_id) REFERENCES app.conversations(id) ON DELETE CASCADE;


--
-- Name: ai_generations ai_generations_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_generations
    ADD CONSTRAINT ai_generations_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: ai_usage_daily ai_usage_daily_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_usage_daily
    ADD CONSTRAINT ai_usage_daily_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: ai_usage_records ai_usage_records_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_usage_records
    ADD CONSTRAINT ai_usage_records_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: ai_user_preferences ai_user_preferences_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.ai_user_preferences
    ADD CONSTRAINT ai_user_preferences_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: attachments attachments_conversation_id_conversations_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.attachments
    ADD CONSTRAINT attachments_conversation_id_conversations_id_fkey FOREIGN KEY (conversation_id) REFERENCES app.conversations(id) ON DELETE CASCADE;


--
-- Name: attachments attachments_message_id_messages_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.attachments
    ADD CONSTRAINT attachments_message_id_messages_id_fkey FOREIGN KEY (message_id) REFERENCES app.messages(id) ON DELETE SET NULL;


--
-- Name: attachments attachments_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.attachments
    ADD CONSTRAINT attachments_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: audit_events audit_events_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.audit_events
    ADD CONSTRAINT audit_events_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: bot_policies bot_policies_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.bot_policies
    ADD CONSTRAINT bot_policies_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: bot_tool_grants bot_tool_grants_agent_id_agents_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.bot_tool_grants
    ADD CONSTRAINT bot_tool_grants_agent_id_agents_id_fkey FOREIGN KEY (agent_id) REFERENCES app.agents(id) ON DELETE CASCADE;


--
-- Name: bot_tool_grants bot_tool_grants_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.bot_tool_grants
    ADD CONSTRAINT bot_tool_grants_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: cell_plugin_tools cell_plugin_tools_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.cell_plugin_tools
    ADD CONSTRAINT cell_plugin_tools_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: cell_plugin_tools cell_plugin_tools_plugin_row_id_cell_plugins_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.cell_plugin_tools
    ADD CONSTRAINT cell_plugin_tools_plugin_row_id_cell_plugins_id_fkey FOREIGN KEY (plugin_row_id) REFERENCES app.cell_plugins(id) ON DELETE CASCADE;


--
-- Name: cell_plugins cell_plugins_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.cell_plugins
    ADD CONSTRAINT cell_plugins_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: conversation_members conversation_members_conversation_id_conversations_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.conversation_members
    ADD CONSTRAINT conversation_members_conversation_id_conversations_id_fkey FOREIGN KEY (conversation_id) REFERENCES app.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_members conversation_members_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.conversation_members
    ADD CONSTRAINT conversation_members_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.conversations
    ADD CONSTRAINT conversations_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_unit_id_org_units_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.conversations
    ADD CONSTRAINT conversations_unit_id_org_units_id_fkey FOREIGN KEY (unit_id) REFERENCES app.org_units(id) ON DELETE SET NULL;


--
-- Name: device_commands device_commands_device_id_devices_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.device_commands
    ADD CONSTRAINT device_commands_device_id_devices_id_fkey FOREIGN KEY (device_id) REFERENCES app.devices(id) ON DELETE CASCADE;


--
-- Name: device_commands device_commands_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.device_commands
    ADD CONSTRAINT device_commands_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: device_commands device_commands_work_session_id_work_sessions_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.device_commands
    ADD CONSTRAINT device_commands_work_session_id_work_sessions_id_fkey FOREIGN KEY (work_session_id) REFERENCES app.work_sessions(id) ON DELETE CASCADE;


--
-- Name: device_enrollments device_enrollments_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.device_enrollments
    ADD CONSTRAINT device_enrollments_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: device_grants device_grants_device_id_devices_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.device_grants
    ADD CONSTRAINT device_grants_device_id_devices_id_fkey FOREIGN KEY (device_id) REFERENCES app.devices(id) ON DELETE CASCADE;


--
-- Name: device_grants device_grants_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.device_grants
    ADD CONSTRAINT device_grants_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: devices devices_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.devices
    ADD CONSTRAINT devices_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: mcp_server_tools mcp_server_tools_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.mcp_server_tools
    ADD CONSTRAINT mcp_server_tools_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: mcp_server_tools mcp_server_tools_server_id_mcp_servers_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.mcp_server_tools
    ADD CONSTRAINT mcp_server_tools_server_id_mcp_servers_id_fkey FOREIGN KEY (server_id) REFERENCES app.mcp_servers(id) ON DELETE CASCADE;


--
-- Name: mcp_servers mcp_servers_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.mcp_servers
    ADD CONSTRAINT mcp_servers_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: message_pins message_pins_conversation_id_conversations_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_pins
    ADD CONSTRAINT message_pins_conversation_id_conversations_id_fkey FOREIGN KEY (conversation_id) REFERENCES app.conversations(id) ON DELETE CASCADE;


--
-- Name: message_pins message_pins_message_id_messages_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_pins
    ADD CONSTRAINT message_pins_message_id_messages_id_fkey FOREIGN KEY (message_id) REFERENCES app.messages(id) ON DELETE CASCADE;


--
-- Name: message_pins message_pins_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_pins
    ADD CONSTRAINT message_pins_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: message_reactions message_reactions_message_id_messages_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_reactions
    ADD CONSTRAINT message_reactions_message_id_messages_id_fkey FOREIGN KEY (message_id) REFERENCES app.messages(id) ON DELETE CASCADE;


--
-- Name: message_reactions message_reactions_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_reactions
    ADD CONSTRAINT message_reactions_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: message_saves message_saves_message_id_messages_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_saves
    ADD CONSTRAINT message_saves_message_id_messages_id_fkey FOREIGN KEY (message_id) REFERENCES app.messages(id) ON DELETE CASCADE;


--
-- Name: message_saves message_saves_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_saves
    ADD CONSTRAINT message_saves_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: message_versions message_versions_message_id_messages_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_versions
    ADD CONSTRAINT message_versions_message_id_messages_id_fkey FOREIGN KEY (message_id) REFERENCES app.messages(id) ON DELETE CASCADE;


--
-- Name: message_versions message_versions_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.message_versions
    ADD CONSTRAINT message_versions_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_conversations_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.messages
    ADD CONSTRAINT messages_conversation_id_conversations_id_fkey FOREIGN KEY (conversation_id) REFERENCES app.conversations(id) ON DELETE CASCADE;


--
-- Name: messages messages_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.messages
    ADD CONSTRAINT messages_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: model_providers model_providers_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.model_providers
    ADD CONSTRAINT model_providers_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: model_providers model_providers_secret_id_secrets_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.model_providers
    ADD CONSTRAINT model_providers_secret_id_secrets_id_fkey FOREIGN KEY (secret_id) REFERENCES app.secrets(id) ON DELETE SET NULL;


--
-- Name: notification_prefs notification_prefs_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.notification_prefs
    ADD CONSTRAINT notification_prefs_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_conversation_id_conversations_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.notifications
    ADD CONSTRAINT notifications_conversation_id_conversations_id_fkey FOREIGN KEY (conversation_id) REFERENCES app.conversations(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_message_id_messages_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.notifications
    ADD CONSTRAINT notifications_message_id_messages_id_fkey FOREIGN KEY (message_id) REFERENCES app.messages(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.notifications
    ADD CONSTRAINT notifications_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.org_members
    ADD CONSTRAINT org_members_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_user_id_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.org_members
    ADD CONSTRAINT org_members_user_id_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: org_units org_units_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.org_units
    ADD CONSTRAINT org_units_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: org_units org_units_parent_id_org_units_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.org_units
    ADD CONSTRAINT org_units_parent_id_org_units_id_fkey FOREIGN KEY (parent_id) REFERENCES app.org_units(id) ON DELETE RESTRICT;


--
-- Name: permission_rules permission_rules_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.permission_rules
    ADD CONSTRAINT permission_rules_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: permission_rules permission_rules_scope_unit_id_org_units_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.permission_rules
    ADD CONSTRAINT permission_rules_scope_unit_id_org_units_id_fkey FOREIGN KEY (scope_unit_id) REFERENCES app.org_units(id) ON DELETE CASCADE;


--
-- Name: projects projects_device_id_devices_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.projects
    ADD CONSTRAINT projects_device_id_devices_id_fkey FOREIGN KEY (device_id) REFERENCES app.devices(id) ON DELETE CASCADE;


--
-- Name: projects projects_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.projects
    ADD CONSTRAINT projects_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: secrets secrets_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.secrets
    ADD CONSTRAINT secrets_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: stream_events stream_events_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.stream_events
    ADD CONSTRAINT stream_events_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: streams streams_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.streams
    ADD CONSTRAINT streams_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: thread_reads thread_reads_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.thread_reads
    ADD CONSTRAINT thread_reads_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: thread_reads thread_reads_root_message_id_messages_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.thread_reads
    ADD CONSTRAINT thread_reads_root_message_id_messages_id_fkey FOREIGN KEY (root_message_id) REFERENCES app.messages(id) ON DELETE CASCADE;


--
-- Name: unit_memberships unit_memberships_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.unit_memberships
    ADD CONSTRAINT unit_memberships_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: unit_memberships unit_memberships_unit_id_org_units_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.unit_memberships
    ADD CONSTRAINT unit_memberships_unit_id_org_units_id_fkey FOREIGN KEY (unit_id) REFERENCES app.org_units(id) ON DELETE CASCADE;


--
-- Name: unit_memberships unit_memberships_user_id_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.unit_memberships
    ADD CONSTRAINT unit_memberships_user_id_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: user_model_credentials user_model_credentials_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.user_model_credentials
    ADD CONSTRAINT user_model_credentials_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: user_model_credentials user_model_credentials_secret_id_secrets_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.user_model_credentials
    ADD CONSTRAINT user_model_credentials_secret_id_secrets_id_fkey FOREIGN KEY (secret_id) REFERENCES app.secrets(id) ON DELETE SET NULL;


--
-- Name: work_approvals work_approvals_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_approvals
    ADD CONSTRAINT work_approvals_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: work_approvals work_approvals_work_session_id_work_sessions_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_approvals
    ADD CONSTRAINT work_approvals_work_session_id_work_sessions_id_fkey FOREIGN KEY (work_session_id) REFERENCES app.work_sessions(id) ON DELETE CASCADE;


--
-- Name: work_prompts work_prompts_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_prompts
    ADD CONSTRAINT work_prompts_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: work_prompts work_prompts_work_session_id_work_sessions_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_prompts
    ADD CONSTRAINT work_prompts_work_session_id_work_sessions_id_fkey FOREIGN KEY (work_session_id) REFERENCES app.work_sessions(id) ON DELETE CASCADE;


--
-- Name: work_sessions work_sessions_conversation_id_conversations_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_sessions
    ADD CONSTRAINT work_sessions_conversation_id_conversations_id_fkey FOREIGN KEY (conversation_id) REFERENCES app.conversations(id) ON DELETE CASCADE;


--
-- Name: work_sessions work_sessions_device_id_devices_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_sessions
    ADD CONSTRAINT work_sessions_device_id_devices_id_fkey FOREIGN KEY (device_id) REFERENCES app.devices(id) ON DELETE CASCADE;


--
-- Name: work_sessions work_sessions_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_sessions
    ADD CONSTRAINT work_sessions_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: work_sessions work_sessions_project_id_projects_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_sessions
    ADD CONSTRAINT work_sessions_project_id_projects_id_fkey FOREIGN KEY (project_id) REFERENCES app.projects(id) ON DELETE CASCADE;


--
-- Name: work_zone_policies work_zone_policies_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: ocw_migrator
--

ALTER TABLE ONLY app.work_zone_policies
    ADD CONSTRAINT work_zone_policies_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: account account_user_id_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_user_id_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: invitation invitation_inviter_id_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.invitation
    ADD CONSTRAINT invitation_inviter_id_user_id_fkey FOREIGN KEY (inviter_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: invitation invitation_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.invitation
    ADD CONSTRAINT invitation_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: member member_organization_id_organization_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.member
    ADD CONSTRAINT member_organization_id_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organization(id) ON DELETE CASCADE;


--
-- Name: member member_user_id_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.member
    ADD CONSTRAINT member_user_id_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: session session_user_id_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: ocw_migrator
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_user_id_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: agent_credentials; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.agent_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_limit_notices; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.agent_limit_notices ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_memories; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.agent_memories ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_tool_calls; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.agent_tool_calls ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_turns; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.agent_turns ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_usage_daily; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.agent_usage_daily ENABLE ROW LEVEL SECURITY;

--
-- Name: agents; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.agents ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_chat_policies; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.ai_chat_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_chat_shares; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.ai_chat_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_chats; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.ai_chats ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_generations; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.ai_generations ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage_daily; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.ai_usage_daily ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage_records; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.ai_usage_records ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_user_preferences; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.ai_user_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: attachments; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events auth_plane; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY auth_plane ON app.audit_events TO ocw_auth USING (true) WITH CHECK (true);


--
-- Name: org_members auth_plane; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY auth_plane ON app.org_members TO ocw_auth USING (true) WITH CHECK (true);


--
-- Name: bot_policies; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.bot_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: bot_tool_grants; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.bot_tool_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: cell_plugin_tools; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.cell_plugin_tools ENABLE ROW LEVEL SECURITY;

--
-- Name: cell_plugins; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.cell_plugins ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_members; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.conversation_members ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: device_commands; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.device_commands ENABLE ROW LEVEL SECURITY;

--
-- Name: device_enrollments; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.device_enrollments ENABLE ROW LEVEL SECURITY;

--
-- Name: device_grants; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.device_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: devices; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.devices ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_server_tools; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.mcp_server_tools ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_servers; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.mcp_servers ENABLE ROW LEVEL SECURITY;

--
-- Name: message_pins; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.message_pins ENABLE ROW LEVEL SECURITY;

--
-- Name: message_reactions; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.message_reactions ENABLE ROW LEVEL SECURITY;

--
-- Name: message_saves; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.message_saves ENABLE ROW LEVEL SECURITY;

--
-- Name: message_versions; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.message_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: model_providers; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.model_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_prefs; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.notification_prefs ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: org_members; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.org_members ENABLE ROW LEVEL SECURITY;

--
-- Name: org_units; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.org_units ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_rules; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.permission_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: secrets; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.secrets ENABLE ROW LEVEL SECURITY;

--
-- Name: stream_events; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.stream_events ENABLE ROW LEVEL SECURITY;

--
-- Name: streams; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.streams ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_credentials tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.agent_credentials USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: agent_limit_notices tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.agent_limit_notices USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: agent_memories tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.agent_memories USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: agent_tool_calls tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.agent_tool_calls USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: agent_turns tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.agent_turns USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: agent_usage_daily tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.agent_usage_daily USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: agents tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.agents USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: ai_chat_policies tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.ai_chat_policies USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: ai_chat_shares tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.ai_chat_shares USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: ai_chats tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.ai_chats USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: ai_generations tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.ai_generations USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: ai_usage_daily tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.ai_usage_daily USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: ai_usage_records tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.ai_usage_records USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: ai_user_preferences tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.ai_user_preferences USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: attachments tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.attachments USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: audit_events tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.audit_events USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: bot_policies tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.bot_policies USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: bot_tool_grants tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.bot_tool_grants USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: cell_plugin_tools tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.cell_plugin_tools USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: cell_plugins tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.cell_plugins USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: conversation_members tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.conversation_members USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: conversations tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.conversations USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: device_commands tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.device_commands USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: device_enrollments tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.device_enrollments USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: device_grants tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.device_grants USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: devices tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.devices USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: mcp_server_tools tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.mcp_server_tools USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: mcp_servers tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.mcp_servers USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: message_pins tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.message_pins USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: message_reactions tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.message_reactions USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: message_saves tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.message_saves USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: message_versions tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.message_versions USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: messages tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.messages USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: model_providers tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.model_providers USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: notification_prefs tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.notification_prefs USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: notifications tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.notifications USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: org_members tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.org_members USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: org_units tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.org_units USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: permission_rules tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.permission_rules USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: projects tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.projects USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: secrets tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.secrets USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: stream_events tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.stream_events USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: streams tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.streams USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: thread_reads tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.thread_reads USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: unit_memberships tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.unit_memberships USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: user_model_credentials tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.user_model_credentials USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: work_approvals tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.work_approvals USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: work_prompts tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.work_prompts USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: work_sessions tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.work_sessions USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: work_zone_policies tenant_isolation; Type: POLICY; Schema: app; Owner: ocw_migrator
--

CREATE POLICY tenant_isolation ON app.work_zone_policies USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));


--
-- Name: thread_reads; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.thread_reads ENABLE ROW LEVEL SECURITY;

--
-- Name: unit_memberships; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.unit_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: user_model_credentials; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.user_model_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: work_approvals; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.work_approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: work_prompts; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.work_prompts ENABLE ROW LEVEL SECURITY;

--
-- Name: work_sessions; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.work_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: work_zone_policies; Type: ROW SECURITY; Schema: app; Owner: ocw_migrator
--

ALTER TABLE app.work_zone_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA app; Type: ACL; Schema: -; Owner: ocw_migrator
--

GRANT USAGE ON SCHEMA app TO ocw_app;
GRANT USAGE ON SCHEMA app TO ocw_auth;


--
-- Name: SCHEMA auth; Type: ACL; Schema: -; Owner: ocw_migrator
--

GRANT USAGE ON SCHEMA auth TO ocw_auth;


--
-- Name: FUNCTION due_attachment_sweeps(p_limit integer, p_now timestamp with time zone); Type: ACL; Schema: app; Owner: ocw_migrator
--

REVOKE ALL ON FUNCTION app.due_attachment_sweeps(p_limit integer, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.due_attachment_sweeps(p_limit integer, p_now timestamp with time zone) TO ocw_app;


--
-- Name: FUNCTION lookup_agent_credential(p_token_hash text); Type: ACL; Schema: app; Owner: ocw_migrator
--

REVOKE ALL ON FUNCTION app.lookup_agent_credential(p_token_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lookup_agent_credential(p_token_hash text) TO ocw_app;


--
-- Name: FUNCTION lookup_device_enrollment(p_code_hash text); Type: ACL; Schema: app; Owner: ocw_migrator
--

REVOKE ALL ON FUNCTION app.lookup_device_enrollment(p_code_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lookup_device_enrollment(p_code_hash text) TO ocw_app;


--
-- Name: FUNCTION lookup_device_token(p_token_hash text); Type: ACL; Schema: app; Owner: ocw_migrator
--

REVOKE ALL ON FUNCTION app.lookup_device_token(p_token_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lookup_device_token(p_token_hash text) TO ocw_app;


--
-- Name: FUNCTION stale_ai_generations(p_limit integer, p_before timestamp with time zone); Type: ACL; Schema: app; Owner: ocw_migrator
--

REVOKE ALL ON FUNCTION app.stale_ai_generations(p_limit integer, p_before timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.stale_ai_generations(p_limit integer, p_before timestamp with time zone) TO ocw_app;


--
-- Name: TABLE agent_credentials; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.agent_credentials TO ocw_app;


--
-- Name: TABLE agent_limit_notices; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.agent_limit_notices TO ocw_app;


--
-- Name: TABLE agent_memories; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.agent_memories TO ocw_app;


--
-- Name: TABLE agent_tool_calls; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.agent_tool_calls TO ocw_app;


--
-- Name: TABLE agent_turns; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.agent_turns TO ocw_app;


--
-- Name: TABLE agent_usage_daily; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.agent_usage_daily TO ocw_app;


--
-- Name: TABLE agents; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.agents TO ocw_app;


--
-- Name: TABLE ai_chat_policies; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.ai_chat_policies TO ocw_app;


--
-- Name: TABLE ai_chat_shares; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.ai_chat_shares TO ocw_app;


--
-- Name: TABLE ai_chats; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.ai_chats TO ocw_app;


--
-- Name: TABLE ai_generations; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.ai_generations TO ocw_app;


--
-- Name: TABLE ai_usage_daily; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.ai_usage_daily TO ocw_app;


--
-- Name: TABLE ai_usage_records; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT ON TABLE app.ai_usage_records TO ocw_app;


--
-- Name: TABLE ai_user_preferences; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.ai_user_preferences TO ocw_app;


--
-- Name: TABLE attachments; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.attachments TO ocw_app;


--
-- Name: TABLE audit_events; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT ON TABLE app.audit_events TO ocw_app;
GRANT SELECT,INSERT ON TABLE app.audit_events TO ocw_auth;


--
-- Name: TABLE bot_policies; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.bot_policies TO ocw_app;


--
-- Name: TABLE bot_tool_grants; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.bot_tool_grants TO ocw_app;


--
-- Name: TABLE cell_plugin_tools; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.cell_plugin_tools TO ocw_app;


--
-- Name: TABLE cell_plugins; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.cell_plugins TO ocw_app;


--
-- Name: TABLE conversation_members; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.conversation_members TO ocw_app;


--
-- Name: TABLE conversations; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.conversations TO ocw_app;


--
-- Name: TABLE device_commands; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.device_commands TO ocw_app;


--
-- Name: TABLE device_enrollments; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.device_enrollments TO ocw_app;


--
-- Name: TABLE device_grants; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.device_grants TO ocw_app;


--
-- Name: TABLE devices; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.devices TO ocw_app;


--
-- Name: TABLE mcp_server_tools; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.mcp_server_tools TO ocw_app;


--
-- Name: TABLE mcp_servers; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.mcp_servers TO ocw_app;


--
-- Name: TABLE message_pins; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.message_pins TO ocw_app;


--
-- Name: TABLE message_reactions; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.message_reactions TO ocw_app;


--
-- Name: TABLE message_saves; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.message_saves TO ocw_app;


--
-- Name: TABLE message_versions; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT ON TABLE app.message_versions TO ocw_app;


--
-- Name: TABLE messages; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.messages TO ocw_app;


--
-- Name: TABLE model_providers; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.model_providers TO ocw_app;


--
-- Name: TABLE notification_prefs; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.notification_prefs TO ocw_app;


--
-- Name: TABLE notifications; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.notifications TO ocw_app;


--
-- Name: TABLE org_members; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.org_members TO ocw_app;
GRANT SELECT,INSERT,UPDATE ON TABLE app.org_members TO ocw_auth;


--
-- Name: TABLE org_units; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.org_units TO ocw_app;


--
-- Name: TABLE permission_rules; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.permission_rules TO ocw_app;


--
-- Name: TABLE projects; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.projects TO ocw_app;


--
-- Name: TABLE secrets; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.secrets TO ocw_app;


--
-- Name: TABLE stream_events; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT ON TABLE app.stream_events TO ocw_app;


--
-- Name: TABLE streams; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.streams TO ocw_app;


--
-- Name: TABLE thread_reads; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.thread_reads TO ocw_app;


--
-- Name: TABLE unit_memberships; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.unit_memberships TO ocw_app;


--
-- Name: TABLE user_model_credentials; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.user_model_credentials TO ocw_app;


--
-- Name: TABLE work_approvals; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.work_approvals TO ocw_app;


--
-- Name: TABLE work_prompts; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.work_prompts TO ocw_app;


--
-- Name: TABLE work_sessions; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.work_sessions TO ocw_app;


--
-- Name: TABLE work_zone_policies; Type: ACL; Schema: app; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.work_zone_policies TO ocw_app;


--
-- Name: TABLE account; Type: ACL; Schema: auth; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.account TO ocw_auth;


--
-- Name: TABLE instance_setup; Type: ACL; Schema: auth; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.instance_setup TO ocw_auth;


--
-- Name: TABLE invitation; Type: ACL; Schema: auth; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.invitation TO ocw_auth;


--
-- Name: TABLE jwks; Type: ACL; Schema: auth; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.jwks TO ocw_auth;


--
-- Name: TABLE member; Type: ACL; Schema: auth; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.member TO ocw_auth;


--
-- Name: TABLE organization; Type: ACL; Schema: auth; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.organization TO ocw_auth;


--
-- Name: TABLE session; Type: ACL; Schema: auth; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.session TO ocw_auth;


--
-- Name: TABLE "user"; Type: ACL; Schema: auth; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth."user" TO ocw_auth;


--
-- Name: TABLE verification; Type: ACL; Schema: auth; Owner: ocw_migrator
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth.verification TO ocw_auth;


--
-- PostgreSQL database dump complete
--

\unrestrict ocwupgradebaseline

