-- A resolution action only moves forward (TP.1; doc 06 §15). What was carried out stays carried out,
-- and what was verified stays verified: an action goes planned → done → verified, or planned →
-- cancelled, and never back. Its content is fixed from the proposal that made it; a later proposal
-- replaces only the actions still planned (they may be deleted), never one already done.

CREATE FUNCTION support.action_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'planned' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a resolution action moves only forward';
  END IF;
  IF NEW.case_id <> OLD.case_id OR NEW.seq <> OLD.seq OR NEW.kind <> OLD.kind OR NEW.description <> OLD.description
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.stock_lot_id IS DISTINCT FROM OLD.stock_lot_id
     OR NOT ((OLD.status = 'planned' AND NEW.status IN ('done', 'cancelled'))
          OR (OLD.status = 'done' AND NEW.status = 'verified' AND NEW.result = OLD.result
              AND NEW.done_by IS NOT DISTINCT FROM OLD.done_by AND NEW.done_at IS NOT DISTINCT FROM OLD.done_at)) THEN
    RAISE EXCEPTION 'a resolution action moves only forward';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_resolution_action_forward BEFORE UPDATE OR DELETE ON support.resolution_action
  FOR EACH ROW EXECUTE FUNCTION support.action_forward_only();
