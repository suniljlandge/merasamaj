# Graph Report - SAMAJ  (2026-08-30)

## Corpus Check
- 69 files · ~149,381 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1477 nodes · 2791 edges · 89 communities (80 shown, 9 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 116 edges (avg confidence: 0.52)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8336ec7d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- campaign-wizard.js
- samaj/app.py
- DESIGN.md
- superadmin.js
- create_collections
- get
- static/app.js
- data_tools.py
- tn_service.py
- _headers
- Requirements
- test_tn_lookup.py
- whatsapp_web_routes.py
- dependencies
- login.js
- /graphify
- pdf_export.py
- Multi-City Tenant Isolation Design
- public/app.js
- wa-backup-dashboard.js
- directory.js
- user-management.js
- whatsapp-login.js
- family-tree-module-check.mjs
- UserManagementTests
- test_user_management.py
- clean_text
- _get_user_id
- output_family_tree_module.js
- tn-service.js
- normalize_registration
- test_tenancy.py
- SelfRegistrationFlowTests
- self-registration-review.js
- get_campaign_payments_collection
- registration.py
- Multi-City Tenant Isolation Implementation Plan
- create_app
- campaign-directory.js
- Correctness Properties
- build_directory_export_rows
- campaign.py
- data-tools.js
- createBackupService
- createSessionManager
- role_can
- execute_campaign_send
- RegistrationPermissionsTests
- index.js
- scope_for_session
- TenantError
- useMongoDBAuthState
- self-register.js
- SAMAJ Registration
- CLAUDE.md
- SAMAJ WhatsApp Web Sidecar
- Components and Interfaces
- Error Handling
- campaign-admin.js
- init
- Design Document: Campaign Manager
- escapeHtml
- create_campaign_with_upi
- _get_database
- handleSubmit
- get_routing_config
- createR2Client
- FakeIndexCollection
- Algorithmic Pseudocode
- Implementation Plan: Campaign Manager
- renderFamilyMembers
- build_campaign_report
- Data Models
- Key Functions with Formal Specifications
- activateWizardStep
- whatsapp-web.js
- ui-routes.js
- Sequence Diagrams
- Testing Strategy
- readFamilyMembers
- campaign-manager.js
- otp-settings.js
- health
- wa-routing.js
- app.py
- start.sh

## God Nodes (most connected - your core abstractions)
1. `create_app()` - 39 edges
2. `UserManagementTests` - 26 edges
3. `clean_text()` - 24 edges
4. `_headers()` - 24 edges
5. `_url()` - 24 edges
6. `_get_user_id()` - 24 edges
7. `init()` - 21 edges
8. `_require_auth()` - 20 edges
9. `SelfRegistrationFlowTests` - 19 edges
10. `TenantError` - 18 edges

## Surprising Connections (you probably didn't know these)
- `test_transfer_registration_rejects_inactive_destination_or_cross_scope()` --uses--> `TenantError`  [INFERRED]
  tests/test_tenancy.py → samaj/tenancy.py
- `UserManagementTests` --uses--> `TenantError`  [INFERRED]
  tests/test_user_management.py → samaj/tenancy.py
- `main()` --calls--> `create_collections()`  [EXTRACTED]
  import_phrase_corrections.py → samaj/db.py
- `transliterate()` --calls--> `transliterate_to_marathi()`  [EXTRACTED]
  import_whm_landmarks.py → samaj/transliterate.py
- `test_ensure_tenant_indexes_covers_city_owned_collections_and_audit()` --calls--> `ensure_tenant_indexes()`  [EXTRACTED]
  tests/test_tenancy.py → samaj/db.py

## Import Cycles
- None detected.

## Communities (89 total, 9 thin omitted)

### Community 0 - "campaign-wizard.js"
Cohesion: 0.06
Nodes (98): applyFilters(), buildQuery(), checkboxRow(), checkWebSendOption(), clearError(), clearPaymentError(), clearTemplateNavError(), deselectRecipientId() (+90 more)

### Community 1 - "samaj/app.py"
Cohesion: 0.08
Nodes (41): append_audit_event(), can_access_directory(), can_edit_registration(), can_view_family_tree(), can_view_registration(), create_pending_submission_for_account(), current_app_registration_database_lookup(), current_owned_registration_id() (+33 more)

### Community 2 - "DESIGN.md"
Cohesion: 0.05
Nodes (41): Badges & Status, Border Radius Scale, Brand & Accent, Breakpoints, Buttons, Cards & Containers, Category Accent (Course Tags), Code (+33 more)

### Community 3 - "superadmin.js"
Cohesion: 0.11
Nodes (42): collectConfigFromForm(), configState, configStatus, createCityForm, downloadExport(), escapeHtml(), escapeHtmlAttribute(), exportBtn (+34 more)

### Community 4 - "create_collections"
Cohesion: 0.29
Nodes (9): main(), main(), normalize(), Uses your existing Google-based transliteration endpoint logic. Replace later…, transliterate(), create_collection(), create_collections(), ensure_tenant_indexes() (+1 more)

### Community 5 - "get"
Cohesion: 0.67
Nodes (3): get, health(), suggest()

### Community 6 - "static/app.js"
Cohesion: 0.05
Nodes (34): addMemberButton, connectionStatus, familyTypeInput, FIELD_GROUPS, filterDistrict, filterTaluka, form, loadMemberDirectory() (+26 more)

### Community 7 - "data_tools.py"
Cohesion: 0.12
Nodes (34): _addr_en(), _addr_mr(), address_report(), analyze_names(), apply_overrides_to_doc(), _apply_overrides_to_field(), _build_options(), clean_address() (+26 more)

### Community 8 - "tn_service.py"
Cohesion: 0.09
Nodes (27): _get_form_fields(), _get_hash(), _get_pid(), get_pipeline_token(), _get_token(), _is_token_expired(), _rand4(), _rand_email() (+19 more)

### Community 9 - "_headers"
Cohesion: 0.11
Nodes (33): connect_session(), decide_route(), disconnect_session(), export_contacts(), get_backup_status(), get_daily_send_stats(), get_profile_pic_history(), get_profile_pic_url() (+25 more)

### Community 10 - "Requirements"
Cohesion: 0.06
Nodes (32): Acceptance Criteria, Acceptance Criteria, Acceptance Criteria, Acceptance Criteria, Acceptance Criteria, Acceptance Criteria, Acceptance Criteria, Acceptance Criteria (+24 more)

### Community 11 - "test_tn_lookup.py"
Cohesion: 0.44
Nodes (8): fail(), header(), info(), lookup_numbers(), ok(), TN Lookup diagnostic test script Run: python test_tn_lookup.py [mobile1]…, test_pipeline(), warn()

### Community 12 - "whatsapp_web_routes.py"
Cohesion: 0.11
Nodes (32): route, backup_status(), download_media(), export_contacts(), fetch_message_history(), get_messages(), profile_pic(), profile_pic_history() (+24 more)

### Community 13 - "dependencies"
Cohesion: 0.07
Nodes (28): @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, cheerio, express, @hapi/boom, mongodb, pino, qrcode-terminal (+20 more)

### Community 14 - "login.js"
Cohesion: 0.09
Nodes (29): activateMode(), clearOtpStatus(), escapeHtml(), getNormalizedMobile(), handleMobileInput(), loadActiveCities(), loginButton, loginModeCopy (+21 more)

### Community 15 - "/graphify"
Cohesion: 0.06
Nodes (30): For --cluster-only, For git commit hook, For /graphify add, For /graphify explain, For /graphify path, For /graphify query, For native CLAUDE.md integration, For --update (incremental re-extraction) (+22 more)

### Community 16 - "pdf_export.py"
Cohesion: 0.14
Nodes (27): _build_watermark_overlay(), _column_widths(), _draw_footer(), _font(), _hard_break(), _harden(), _is_deva(), _latin_font() (+19 more)

### Community 17 - "Multi-City Tenant Isolation Design"
Cohesion: 0.07
Nodes (28): Approved Requirements, Authentication, Authentication and Request Scope, Central Authorization Boundary, Chosen Architecture, Cities, City Management, City-Owned Documents (+20 more)

### Community 18 - "public/app.js"
Cohesion: 0.18
Nodes (27): apiGet(), apiPost(), applyPic(), applyTnToCard(), autoLookupAllContacts(), checkStatus(), disconnectUser(), doLogin() (+19 more)

### Community 19 - "wa-backup-dashboard.js"
Cohesion: 0.16
Nodes (26): applyPicToEl(), applyTnResultToCard(), approveTemplate(), autoLookupAllContacts(), closeChatPopup(), downloadMedia(), escHtml(), fetchOlderMessages() (+18 more)

### Community 20 - "directory.js"
Cohesion: 0.12
Nodes (21): calculateFamilyMembersCount(), closeInvitationModal(), createInvitationModal(), directoryTableBody, escapeAttribute(), escapeHtml(), filterDistrict, filterTaluka (+13 more)

### Community 21 - "user-management.js"
Cohesion: 0.13
Nodes (24): canChangePassword(), canDeleteUser(), changePasswordCancel, changePasswordConfirm, changePasswordDialog, changePasswordError, changePasswordForm, changePasswordInput (+16 more)

### Community 22 - "whatsapp-login.js"
Cohesion: 0.13
Nodes (24): getWaMobile(), handleWaMobileInput(), hideWaPanels(), pollWaStatus(), renderQrCode(), renderQrFallback(), setWaStatus(), startWaStatusPolling() (+16 more)

### Community 23 - "family-tree-module-check.mjs"
Cohesion: 0.21
Nodes (16): countElement, createDisplayGraph(), createStyledEdges(), createStyledNodes(), escapeHtml(), FamilyMemberNode(), FlowApp(), flowElement (+8 more)

### Community 25 - "test_user_management.py"
Cohesion: 0.12
Nodes (8): apply_projection(), apply_update(), FakeCollection, FakeCursor, FakeDeleteResult, FakeInsertResult, FakeUpdateResult, matches_query()

### Community 26 - "clean_text"
Cohesion: 0.15
Nodes (23): add_family_tree_edge(), build_bilingual_name(), build_family_tree_graph_data(), build_registration_full_name(), canonical_tree_person_id(), clean_text(), default_otp_settings(), infer_generation_offset_from_relation() (+15 more)

### Community 27 - "_get_user_id"
Cohesion: 0.13
Nodes (22): backup_running(), connect(), connect_qr(), create_custom_template(), disconnect(), get_qr(), _get_user_id(), Poll for latest QR code. (+14 more)

### Community 28 - "output_family_tree_module.js"
Cohesion: 0.26
Nodes (11): countElement, createStyledEdges(), createStyledNodes(), escapeHtml(), FamilyMemberNode(), FlowApp(), flowElement, loadTree() (+3 more)

### Community 29 - "tn-service.js"
Cohesion: 0.16
Nodes (19): cheerio, DOMAINS, EXPIRY_MARKERS, getFormFields(), getPaymentId(), getPipelineToken(), getToken(), HEADERS (+11 more)

### Community 30 - "normalize_registration"
Cohesion: 0.19
Nodes (4): serialize_registration_document(), normalize_registration(), validate_registration(), FamilyRelationshipSchemaTests

### Community 32 - "test_tenancy.py"
Cohesion: 0.24
Nodes (17): normalize_city_name(), Move a registration between active cities with a durable audit row., transfer_registration(), backfill_city_ids(), ensure_initial_city(), _is_city_owned_document(), migrate_legacy_tenants(), validate_city_references() (+9 more)

### Community 34 - "self-registration-review.js"
Cohesion: 0.19
Nodes (17): escapeHtml(), escapeHtmlAttribute(), formatDate(), formatFullName(), formatMemberName(), formatStatus(), loadReviewQueue(), openSubmissionViewer() (+9 more)

### Community 35 - "get_campaign_payments_collection"
Cohesion: 0.20
Nodes (12): confirm_upi_payment(), get_campaign_payments_collection(), get_campaigns_collection(), Return the 'campaigns' MongoDB collection., Return the 'campaign_payments' MongoDB collection., Validate whether a campaign status transition is permitted. Args: current: The…, Record the user-submitted UPI transaction reference for a campaign. After…, Admin action: confirm a UPI payment and trigger campaign sending. Marks the… (+4 more)

### Community 36 - "registration.py"
Cohesion: 0.27
Nodes (12): calculate_family_members_count(), _is_blank_member(), _normalize_family_member(), normalize_family_members(), normalize_member_id_list(), normalize_phone(), normalize_public_mobile(), normalize_relation_key() (+4 more)

### Community 37 - "Multi-City Tenant Isolation Implementation Plan"
Cohesion: 0.12
Nodes (15): File Map and Ownership, Global Constraints, Multi-City Tenant Isolation Implementation Plan, Plan Self-Review, Task 10: Add Superadmin City and Transfer-History UI, Task 11: Disabled-City Enforcement, Full Regression Matrix, and Static Audit, Task 1: Add Pure Tenant Primitives and Collection Contracts, Task 2: Implement Idempotent Washim Migration and Validation (+7 more)

### Community 38 - "create_app"
Cohesion: 0.19
Nodes (19): build_corrected_phrase(), create_app(), env_flag(), get_ad_templates(), Return the list of available WhatsApp ad templates for the campaign wizard.…, _collect_bilingual_correction(), collect_transliteration_corrections(), load_corrections() (+11 more)

### Community 39 - "campaign-directory.js"
Cohesion: 0.31
Nodes (15): bilingual(), escapeAttr(), escapeHtml(), init(), joinName(), loadMembers(), maskMobile(), membersCount() (+7 more)

### Community 40 - "Correctness Properties"
Cohesion: 0.13
Nodes (15): Correctness Properties, Property 10: Redirect determinism, Property 11: Template variable resolution length preservation, Property 12: Phone number normalization, Property 13: Webhook idempotency, Property 14: Session isolation, Property 1: Payment-before-send guarantee, Property 2: Payment amount correctness (+7 more)

### Community 41 - "build_directory_export_rows"
Cohesion: 0.20
Nodes (15): _applicant_full_name(), _bilingual_en(), _bilingual_mr(), build_directory_export_rows(), _build_person_name_map(), export_relation_options(), _format_created_at(), _format_relationship_type() (+7 more)

### Community 42 - "campaign.py"
Cohesion: 0.18
Nodes (17): _address_en(), _family_members_count(), get_areas_with_counts(), get_distinct_surname_groups(), get_hof_by_area(), _hof_name(), Campaign Manager module. Provides MongoDB collection accessors, status…, Extract the English text from a bilingual {en, mr} field (or plain string). (+9 more)

### Community 43 - "data-tools.js"
Cohesion: 0.23
Nodes (12): activateTab(), escapeHtml(), exportBtn, FLAGS, loadAddressAreas(), loadAreaDetail(), renderResult(), renderUnaligned() (+4 more)

### Community 44 - "createBackupService"
Cohesion: 0.15
Nodes (8): createBackupService(), _doFullBackup(), runFullBackup(), crypto, PROFILE_PIC_CONCURRENCY, PROFILE_PIC_DELAY, { PutObjectCommand }, sleep()

### Community 45 - "createSessionManager"
Cohesion: 0.21
Nodes (8): clearAuthState(), createSessionManager(), attachContactListeners(), connectWithOTP(), connectWithQR(), reconnect(), restoreSessions(), startPresenceKeepAlive()

### Community 46 - "role_can"
Cohesion: 0.18
Nodes (14): Check whether a role has a capability per the configurable matrix., role_can(), all_sessions(), approve_template(), delete_template(), list_custom_templates(), Resolve the request tenant without widening WhatsApp data access., List custom templates. Admins see all; regular users see only their own. (+6 more)

### Community 47 - "execute_campaign_send"
Cohesion: 0.16
Nodes (14): execute_campaign_send(), normalize_wa_number(), Best-effort conversion of a value to ObjectId, returning the raw value…, Normalize an Indian mobile number to WhatsApp format (91XXXXXXXXXX). Strips all…, Send a paid campaign's WhatsApp template messages to every recipient. Called…, Resolve a salutation toggle answer into its display text. Accepts one of the…, Replace placeholders in template variables with recipient data. Recognized…, Truncate an error description to at most 500 characters (Requirement 7.3). (+6 more)

### Community 49 - "index.js"
Cohesion: 0.18
Nodes (12): { createBackupService }, { createR2Client }, { createRoutes }, { createSessionManager }, { createUIRoutes }, express, logger, main() (+4 more)

### Community 50 - "scope_for_session"
Cohesion: 0.27
Nodes (12): Any, city_ids_match(), is_superadmin(), scope_for_session(), scoped_query(), TenantScope, test_global_scope_does_not_add_city_predicate(), test_is_superadmin_accepts_only_super_admin_role() (+4 more)

### Community 51 - "TenantError"
Cohesion: 0.24
Nodes (9): parametrize, Raised when a city-scoped request cannot establish a safe scope., require_active_city(), TenantError, FakeCitiesCollection, test_invalid_city_scope_fails_closed(), test_normalize_city_name_rejects_blank_or_non_text_values(), test_require_active_city_rejects_missing_or_inactive_city() (+1 more)

### Community 52 - "useMongoDBAuthState"
Cohesion: 0.22
Nodes (11): hasAuthState(), { initAuthCreds, BufferJSON }, { proto }, useMongoDBAuthState(), getAuthState(), readData(), removeData(), writeData() (+3 more)

### Community 53 - "self-register.js"
Cohesion: 0.26
Nodes (12): escapeHtml(), formatDate(), formatStatus(), hasRegistrationData(), historyContainer, initializeSelfRegistrationPage(), loadLocationsAndSetupDropdowns(), loadSelfRegistrationHistory() (+4 more)

### Community 54 - "SAMAJ Registration"
Cohesion: 0.20
Nodes (9): AI4Bharat IndicXlit Suggestions, Campaign Manager configuration, Deploy IndicXlit on Render, Deploy on Render, Environment Variables, Marathi Corrections, Run, SAMAJ Registration (+1 more)

### Community 56 - "SAMAJ WhatsApp Web Sidecar"
Cohesion: 0.20
Nodes (9): API Endpoints, Architecture, Backup, Messaging, MongoDB Collections Created, Rate Limits & Safety, SAMAJ WhatsApp Web Sidecar, Session (+1 more)

### Community 57 - "Components and Interfaces"
Cohesion: 0.22
Nodes (9): Component 1: Auth & Routing (Modified), Component 2: Campaign Manager Page (Tabbed UI), Component 3: Campaign Wizard (Frontend - 5 Steps), Component 4: Campaign API Routes, Component 5: Payment Service (Razorpay), Component 6: Audience Builder, Component 7: WhatsApp Delivery Service, Component 8: Razorpay Webhook Handler (+1 more)

### Community 58 - "Error Handling"
Cohesion: 0.22
Nodes (9): Error Handling, Error Scenario 1: Razorpay Order Creation Fails, Error Scenario 2: Payment Not Captured (Timeout/Abandonment), Error Scenario 3: Webhook Signature Invalid, Error Scenario 4: Duplicate Webhook Event, Error Scenario 5: WhatsApp Credentials Missing, Error Scenario 6: WhatsApp API Rate Limit, Error Scenario 7: Invalid Template Name (+1 more)

### Community 59 - "campaign-admin.js"
Cohesion: 0.44
Nodes (8): approveTemplate(), confirmPayment(), esc(), formatDate(), loadPendingPayments(), loadPendingTemplates(), rejectPayment(), rejectTemplate()

### Community 60 - "init"
Cohesion: 0.44
Nodes (8): init(), checkBackupBeforeDisconnect(), checkStatus(), doConnectQR(), doDisconnect(), loadStats(), refreshDropdown(), updateDot()

### Community 61 - "Design Document: Campaign Manager"
Cohesion: 0.25
Nodes (7): Architecture, Dependencies, Design Document: Campaign Manager, Example Usage, Overview, Performance Considerations, Security Considerations

### Community 62 - "escapeHtml"
Cohesion: 0.25
Nodes (11): buildRelationshipTargetOptions(), escapeAttribute(), escapeHtml(), findMarathiPair(), loadRecentRecords(), renderApplicantFields(), renderBilingualField(), renderRecentCard() (+3 more)

### Community 63 - "create_campaign_with_upi"
Cohesion: 0.17
Nodes (12): send_otp_message(), build_upi_link(), create_campaign_with_upi(), _get_upi_id(), _get_upi_payee_name(), Return the configured UPI ID (VPA) for receiving payments. Reads from Flask app…, Return the configured UPI payee display name. Reads from Flask app config first…, Return True when a UPI ID is configured for receiving payments. (+4 more)

### Community 64 - "_get_database"
Cohesion: 0.25
Nodes (8): get_campaign_messages_collection(), _get_database(), _get_settings_collection(), load_whatsapp_settings(), Return the 'app_settings' MongoDB collection (OTP / WhatsApp settings)., Load Meta WhatsApp delivery credentials from the settings collection. Reads the…, Return the app's MongoDB database instance via the registrations collection., Return the 'campaign_messages' MongoDB collection.

### Community 65 - "handleSubmit"
Cohesion: 0.29
Nodes (10): capitalizeWords(), clamp(), clearFieldErrors(), clearMessage(), handleSubmit(), loadLocations(), populateRegistrationForm(), setBilingualFieldValue() (+2 more)

### Community 66 - "get_routing_config"
Cohesion: 0.29
Nodes (8): _default_routing_config(), get_routing_config(), _get_settings_col(), Get the app_settings collection., Default routing engine configuration., Get the current routing engine configuration (super admin only)., Save routing engine configuration (super admin only)., save_routing_config()

### Community 67 - "createR2Client"
Cohesion: 0.29
Nodes (4): createNullClient(), createR2Client(), { getSignedUrl }, {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
}

### Community 68 - "FakeIndexCollection"
Cohesion: 0.29
Nodes (3): FakeIndexCollection, FakeIndexDatabase, test_ensure_tenant_indexes_covers_city_owned_collections_and_audit()

### Community 69 - "Algorithmic Pseudocode"
Cohesion: 0.33
Nodes (6): Account Type Routing Algorithm, Algorithmic Pseudocode, Audience Preview (HOF Selection with Cascading Filters), Campaign Creation with Payment Order, Campaign Send Execution (Post-Payment), Razorpay Webhook Processing

### Community 70 - "Implementation Plan: Campaign Manager"
Cohesion: 0.33
Nodes (5): Implementation Plan: Campaign Manager, Notes, Overview, Task Dependency Graph, Tasks

### Community 71 - "renderFamilyMembers"
Cohesion: 0.33
Nodes (9): createTemporaryPersonId(), readRelationText(), renderFamilyMembers(), renderMemberCard(), renderRelationshipLink(), renderRelationshipLinks(), requiresSpouseName(), shouldShowMarriageFields() (+1 more)

### Community 72 - "build_campaign_report"
Cohesion: 0.33
Nodes (6): build_campaign_report(), mask_mobile(), _message_timestamp(), Mask a mobile number so only the last 4 digits remain visible. Every character…, Return the UTC delivery-attempt timestamp for a campaign_message. Prefers…, Build a delivery report for a single campaign. Aggregates the campaign_message…

### Community 73 - "Data Models"
Cohesion: 0.40
Nodes (5): Campaign Document, Campaign Message Document, Campaign Payment Document, Data Models, Modified public_account Document

### Community 75 - "activateWizardStep"
Cohesion: 0.38
Nodes (7): activateWizardStep(), activateWizardStepForErrors(), findInputForFieldName(), getWizardStepForField(), highlightValidationErrors(), isMobileWizardEnabled(), syncWizardMode()

### Community 76 - "whatsapp-web.js"
Cohesion: 0.70
Nodes (4): checkStatus(), loadStats(), pollForConnection(), updateStatusUI()

### Community 77 - "ui-routes.js"
Cohesion: 0.40
Nodes (4): activeTokens, crypto, fs, path

### Community 78 - "Sequence Diagrams"
Cohesion: 0.50
Nodes (4): Campaign Wizard Flow (Steps 1-5), Login & Redirect Flow, Razorpay Webhook Flow (Detailed), Sequence Diagrams

### Community 79 - "Testing Strategy"
Cohesion: 0.50
Nodes (4): Integration Testing Approach, Property-Based Testing Approach, Testing Strategy, Unit Testing Approach

### Community 80 - "readFamilyMembers"
Cohesion: 0.67
Nodes (4): readBilingualValue(), readFamilyMembers(), readRegistration(), readRelationshipLinks()

### Community 81 - "campaign-manager.js"
Cohesion: 0.83
Nodes (3): activateTab(), logout(), resetWizard()

### Community 83 - "health"
Cohesion: 0.50
Nodes (4): is_service_available(), Check if the WhatsApp Web sidecar service is running. Single fast attempt — the…, health(), Check if WhatsApp Web sidecar is available.

## Knowledge Gaps
- **341 isolated node(s):** `memberId`, `titleElement`, `countElement`, `flowElement`, `memberId` (+336 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `create_app()` connect `create_app` to `_get_database`, `samaj/app.py`, `test_tenancy.py`, `get_campaign_payments_collection`, `create_collections`, `registration.py`, `SelfRegistrationFlowTests`, `tn_service.py`, `campaign.py`, `RegistrationPermissionsTests`, `scope_for_session`, `TenantError`, `app.py`, `UserManagementTests`, `test_user_management.py`, `clean_text`, `normalize_registration`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `app.py`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `create_app()` (e.g. with `current_tenant_scope()` and `get_campaign_messages_collection()`) actually correct?**
  _`create_app()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `memberId`, `titleElement`, `countElement` to the rest of the system?**
  _341 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `campaign-wizard.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05898989898989899 - nodes in this community are weakly interconnected._
- **Should `samaj/app.py` be split into smaller, more focused modules?**
  _Cohesion score 0.07908163265306123 - nodes in this community are weakly interconnected._
- **Should `DESIGN.md` be split into smaller, more focused modules?**
  _Cohesion score 0.047619047619047616 - nodes in this community are weakly interconnected._