-- ADR-0010: task_events and run_events are append-only journals. Rows are inserted, never changed or removed.
-- TRUNCATE is not covered on purpose (row triggers do not fire for it): the test harness resets tables with it.
CREATE FUNCTION "forbid_journal_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "task_events_append_only"
	BEFORE UPDATE OR DELETE ON "task_events"
	FOR EACH ROW EXECUTE FUNCTION "forbid_journal_mutation"();--> statement-breakpoint
CREATE TRIGGER "run_events_append_only"
	BEFORE UPDATE OR DELETE ON "run_events"
	FOR EACH ROW EXECUTE FUNCTION "forbid_journal_mutation"();
