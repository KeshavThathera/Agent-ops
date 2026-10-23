# Acceptance criteria → verification

B = backend pytest (`backend/tests`), E = Playwright (`frontend/e2e`). All listed tests passed in the final run.

| # | Criterion | Verified by |
|---|---|---|
| 1 | One submission → one workflow and one linked ticket | B `test_submit_creates_one_workflow_and_one_ticket` (incl. idempotent resubmit) · E VPN flow |
| 2 | Evidence opens the correct source | B `test_evidence_opens_correct_source` · E `evidence link opens the cited chunk` |
| 3 | Sensitive action pauses before execution | B `test_sensitive_action_pauses_before_execution` |
| 4 | Employee cannot approve via UI or API | B `test_employee_cannot_approve_via_api` (403 + audit `approval.decision_denied`) · E `employees cannot reach the approval queue` |
| 5 | Approval resumes the correct checkpoint | B `test_approval_resumes_checkpoint_and_resolution_is_verified` |
| 6 | Rejection prevents the action | B `test_rejection_prevents_action` |
| 7 | Repeated clicks do not repeat execution | B `test_repeated_approval_clicks_execute_once` (200, 409, 409; one execution) |
| 8 | Modified parameters invalidate approval | B `test_modified_parameters_invalidate_prior_approval`, `test_tampered_step_after_approval_is_not_executed` |
| 9 | Refresh preserves state | B `test_refresh_preserves_state_and_event_cursor`; UI reads persisted state and resumes SSE after the last event id |
| 10 | Backend restart recovers pending work | B `test_restart_recovers_pending_work`, `test_crash_between_claim_and_execution_reconciles_without_double_execution` |
| 11 | Retry does not duplicate tickets | B `test_transient_ticketing_failure_retries_without_duplicate_ticket`, `test_permanent_ticketing_failure_fails_safely_then_manual_retry` |
| 12 | Insufficient evidence → clarification or review | B `test_insufficient_evidence_routes_to_human_review`, `test_ambiguous_request_asks_and_resumes_same_workflow` · E ambiguous flow |
| 13 | Unrelated user cannot read ticket or stream | B `test_unrelated_user_cannot_read_ticket_or_stream` |
| 14 | Resolution requires verification | B `test_failed_verification_does_not_resolve`, `test_slow_laptop_requires_user_confirmation` |
| 15 | Prompt injection does not bypass policy | B `test_prompt_injection_in_document_does_not_bypass_policy`, `test_uploaded_injection_is_flagged` |
| 16 | Dashboard counts match stored records | B `test_dashboard_counts_match_stored_records` |
| 17 | Evaluation results come from recorded runs | B `test_evaluation_results_come_from_recorded_runs` |
| 18 | Demo mode works without credentials and is labelled | B `test_demo_mode_works_without_credentials_and_live_is_refused` · E mobile test checks the badge |
| 19 | No provider keys in client bundle or logs | B `test_secrets_never_leave_server` (API responses, stored messages, audit) · bundle grep in README |
| 20 | Mobile and keyboard usable | E `core pages are usable on a phone without horizontal scrolling`, `keyboard: skip link and dialog focus` |

Additional coverage: unsafe request (G), printer takeover/escalation (D), cancel, policy-change audit and locked
policies, CSRF header, tool-layer blocking of unknown tools and invalid args, live-mode repair/failed-repair/provider
errors with a mocked model, verifier rejection of unsupported conclusions, uploads (TXT/MD, unsupported type, fake
PDF, scanned PDF → OCR required, size limit, role check), real MCP subprocess invocation, ChromaDB retrieval and
stale-free replacement, and Alembic migration ↔ model parity.

Not covered by automated tests: live calls to the Anthropic API (no key available), PostgreSQL/Docker Compose.
