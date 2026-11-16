ALTER TABLE saved_authorizations DROP CONSTRAINT saved_authorizations_operation_check;
ALTER TABLE saved_authorizations ADD CONSTRAINT saved_authorizations_operation_check CHECK(operation IN ('read','write','execute'));
