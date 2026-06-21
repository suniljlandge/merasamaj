# Graph Report - SAMAJ  (2026-06-21)

## Corpus Check
- 70 files · ~209,077 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1436 nodes · 2804 edges · 102 communities detected
- Extraction: 77% EXTRACTED · 23% INFERRED · 0% AMBIGUOUS · INFERRED: 650 edges (avg confidence: 0.72)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 93|Community 93]]
- [[_COMMUNITY_Community 94|Community 94]]
- [[_COMMUNITY_Community 95|Community 95]]
- [[_COMMUNITY_Community 96|Community 96]]
- [[_COMMUNITY_Community 97|Community 97]]
- [[_COMMUNITY_Community 98|Community 98]]
- [[_COMMUNITY_Community 99|Community 99]]
- [[_COMMUNITY_Community 100|Community 100]]
- [[_COMMUNITY_Community 101|Community 101]]
- [[_COMMUNITY_Community 102|Community 102]]
- [[_COMMUNITY_Community 103|Community 103]]

## God Nodes (most connected - your core abstractions)
1. `FakeDatabase` - 163 edges
2. `normalize_wa_number()` - 48 edges
3. `resolve_body_vars()` - 41 edges
4. `FakeCollection` - 38 edges
5. `execute_campaign_send()` - 26 edges
6. `validate_campaign_status_transition()` - 25 edges
7. `create_app()` - 24 edges
8. `create_campaign_with_upi()` - 24 edges
9. `get_hof_by_area()` - 23 edges
10. `TestNormalizeWaNumber` - 23 edges

## Surprising Connections (you probably didn't know these)
- `create_app()` --calls--> `get_database()`  [INFERRED]
  samaj\app.py → samaj\db.py
- `normalize_wa_number()` --calls--> `test_valid_inputs_produce_12_char_wa_number()`  [INFERRED]
  samaj\campaign.py → tests\test_campaign_properties.py
- `normalize_wa_number()` --calls--> `test_normalization_is_idempotent()`  [INFERRED]
  samaj\campaign.py → tests\test_campaign_properties.py
- `Unit tests for the standalone redirect routing function.` --uses--> `FakeDatabase`  [INFERRED]
  tests\test_campaigner_routing.py → tests\test_user_management.py
- `Integration tests for verify-otp account type routing.` --uses--> `FakeDatabase`  [INFERRED]
  tests\test_campaigner_routing.py → tests\test_user_management.py

## Communities

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (102): confirm_upi_payment(), Record the user-submitted UPI transaction reference for a campaign.      After, Admin action: confirm a UPI payment and trigger campaign sending.      Marks t, submit_upi_reference(), Tests for Campaign Manager environment configuration (Task 13.2).  Verifies th, The UPI_ID and UPI_PAYEE_NAME env vars must be wired into app.config., The three RAZORPAY_* env vars must be wired into app.config., WhatsApp credentials come from the existing settings collection. (+94 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (21): create_app(), env_flag(), find_public_account_by_mobile(), Look up a public_account by its 10-digit mobile, tolerating legacy formats., execute_campaign_send(), load_whatsapp_settings(), Load Meta WhatsApp delivery credentials from the settings collection.      Rea, Send a paid campaign's WhatsApp template messages to every recipient.      Cal (+13 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (68): loadMemberDirectory(), send_otp_message(), init(), activateTab(), loadAddressAreas(), loadAreaDetail(), renderResult(), renderUnaligned() (+60 more)

### Community 3 - "Community 3"
Cohesion: 0.03
Nodes (52): Resolve a salutation toggle answer into its display text.      Accepts one of, Replace placeholders in template variables with recipient data.      Recognize, resolve_body_vars(), salutation_text(), test_output_entries_are_all_strings(), test_output_length_equals_input_length(), Tests for resolve_body_vars() — template variable resolution.  Validates Requi, Requirement 13.4: Missing name key -> empty string. (+44 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (83): applyFilters(), buildQuery(), checkboxRow(), clearError(), clearPaymentError(), clearTemplateNavError(), deselectRecipientId(), el() (+75 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (61): add_family_tree_edge(), append_audit_event(), _applicant_full_name(), _bilingual_en(), _bilingual_mr(), build_bilingual_name(), build_directory_export_rows(), build_family_tree_graph_data() (+53 more)

### Community 6 - "Community 6"
Cohesion: 0.04
Nodes (62): createBackupService(), main(), createNullClient(), createR2Client(), createRoutes(), createSessionManager(), connect_session(), decide_route() (+54 more)

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (63): _address_en(), build_campaign_report(), build_upi_link(), _family_members_count(), get_ad_templates(), get_campaign_messages_collection(), get_campaign_payments_collection(), get_campaigns_collection() (+55 more)

### Community 8 - "Community 8"
Cohesion: 0.06
Nodes (25): create_campaign_with_upi(), Create a campaign and generate a UPI payment link for it.      Validates the r, Validate whether a campaign status transition is permitted.      Args:, validate_campaign_status_transition(), CreateCampaignWithUpiTests, _make_recipients(), _patched_campaign_env(), Property-based tests for campaign payment correctness (task 6.4).  Uses the Hy (+17 more)

### Community 9 - "Community 9"
Cohesion: 0.06
Nodes (11): normalize_wa_number(), Normalize an Indian mobile number to WhatsApp format (91XXXXXXXXXX).      Stri, Unit tests for normalize_wa_number() phone normalization utility., A number already in 91XXXXXXXXXX format should pass through., Numbers starting with 0-5 after prefix removal are invalid., Output must be exactly 12 chars matching 91[6-9]\\d{9}., Tests for phone number normalization to WhatsApp format., TestNormalizeWaNumber (+3 more)

### Community 10 - "Community 10"
Cohesion: 0.09
Nodes (32): Return the configured default account type for new mobile signups.      Reads, read_default_account_type(), _collect_bilingual_correction(), collect_transliteration_corrections(), normalize_source(), save_corrections(), bulk_import(), clean() (+24 more)

### Community 11 - "Community 11"
Cohesion: 0.09
Nodes (36): activateWizardStep(), activateWizardStepForErrors(), buildRelationshipTargetOptions(), clamp(), clearFieldErrors(), clearMessage(), createTemporaryPersonId(), escapeAttribute() (+28 more)

### Community 12 - "Community 12"
Cohesion: 0.07
Nodes (29): classify_area(), get_redirect_for_account(), Determine the post-OTP redirect target for a public_account.      Routing rule, _en(), _expected_area_counts(), _fake_matches(), _FakeCollection, formatted_indian_mobile() (+21 more)

### Community 13 - "Community 13"
Cohesion: 0.11
Nodes (37): build_corrected_phrase(), _addr_en(), _addr_mr(), address_report(), analyze_names(), apply_overrides_to_doc(), _apply_overrides_to_field(), _build_options() (+29 more)

### Community 14 - "Community 14"
Cohesion: 0.09
Nodes (24): load_corrections(), apply_projection(), apply_update(), FakeCursor, FakeDeleteResult, FakeInsertResult, FakeUpdateResult, matches_query() (+16 more)

### Community 15 - "Community 15"
Cohesion: 0.09
Nodes (8): CampaignAreasEndpointTests, CampaignListAndDetailEndpointTests, CampaignSurnameGroupsEndpointTests, CampaignTemplatesEndpointTests, Tests for the GET /api/campaigns/areas endpoint (Requirements 3.3, 3.4)., Tests for the GET /api/campaigns/surname-groups endpoint     (Requirement 3.1)., Tests for the GET /api/campaigns/templates endpoint     (Requirements 4.1, 4.2), Tests for GET /api/campaigns and GET /api/campaigns/<id> endpoints     (Require

### Community 16 - "Community 16"
Cohesion: 0.14
Nodes (27): _build_watermark_overlay(), _column_widths(), _draw_footer(), _font(), _hard_break(), _harden(), _is_deva(), _latin_font() (+19 more)

### Community 17 - "Community 17"
Cohesion: 0.16
Nodes (24): collectConfigFromForm(), downloadExport(), escapeHtml(), escapeHtmlAttribute(), fillSelect(), fillSortOptions(), initialize(), loadExportColumns() (+16 more)

### Community 18 - "Community 18"
Cohesion: 0.24
Nodes (19): get_areas_with_counts(), Compute available areas with family counts for the Area filter dropdown., _bilingual(), FakeCollection, make_hof(), _matches(), Tests for samaj.campaign.get_areas_with_counts — area dropdown counts.  Covers, sample_docs() (+11 more)

### Community 19 - "Community 19"
Cohesion: 0.27
Nodes (15): get_distinct_surname_groups(), Return distinct surnameGroup values for the surname filter dropdown.      Quer, FakeCollection, make_doc(), _matches(), Tests for samaj.campaign.get_distinct_surname_groups — surname dropdown.  Cove, sample_docs(), test_combined_district_taluka_filter() (+7 more)

### Community 20 - "Community 20"
Cohesion: 0.17
Nodes (4): is_campaigner_session(), Return True when the current session is a public session whose stored     accou, Tests for is_campaigner_session, @require_campaigner, and registrant-only     e, SessionIsolationTests

### Community 21 - "Community 21"
Cohesion: 0.23
Nodes (7): _FakeResponse, Unit tests for send_single_template_message() WhatsApp delivery (Task 7.3).  C, Minimal stand-in for a requests.Response object., _send(), TestSendSingleTemplateMessageFailure, TestSendSingleTemplateMessageRateLimit, TestSendSingleTemplateMessageSuccess

### Community 22 - "Community 22"
Cohesion: 0.3
Nodes (15): bilingual(), escapeAttr(), escapeHtml(), init(), joinName(), loadMembers(), maskMobile(), membersCount() (+7 more)

### Community 23 - "Community 23"
Cohesion: 0.19
Nodes (4): _Base, OtpRateLimitTests, Tests for OTP request rate limiting and the global new-signup default account t, SignupDefaultTests

### Community 24 - "Community 24"
Cohesion: 0.31
Nodes (11): Resolve selected registration ids into recipient dicts server-side.      Full, resolve_recipients_by_ids(), _doc(), FakeCollection, _matches(), Tests for samaj.campaign.resolve_recipients_by_ids.  The campaign wizard sends, test_dedups_by_mobile_number(), test_empty_input_returns_empty() (+3 more)

### Community 25 - "Community 25"
Cohesion: 0.26
Nodes (11): createDisplayGraph(), createStyledEdges(), createStyledNodes(), escapeHtml(), FamilyMemberNode(), FlowApp(), isSpouseRelation(), loadTree() (+3 more)

### Community 26 - "Community 26"
Cohesion: 0.28
Nodes (10): escapeHtml(), escapeHtmlAttribute(), formatFullName(), formatMemberName(), formatStatus(), openSubmissionViewer(), renderDetailRow(), renderFamilyMemberCard() (+2 more)

### Community 27 - "Community 27"
Cohesion: 0.32
Nodes (2): CampaignReportEndpointTests, Tests for the GET /api/campaigns/<id>/report endpoint.  Covers @require_campai

### Community 28 - "Community 28"
Cohesion: 0.21
Nodes (8): create_collection(), create_collections(), get_database(), main(), main(), normalize(), Uses your existing Google-based transliteration endpoint logic.     Replace lat, transliterate()

### Community 29 - "Community 29"
Cohesion: 0.26
Nodes (4): AudiencePreviewEndpointTests, _bilingual(), _make_hof(), Tests for the GET /api/campaigns/audience-preview endpoint.  Covers @require_c

### Community 30 - "Community 30"
Cohesion: 0.39
Nodes (8): escapeHtml(), formatDate(), formatStatus(), hasRegistrationData(), initializeSelfRegistrationPage(), loadSelfRegistrationHistory(), normalizeInitialSubmission(), renderHistoryCard()

### Community 31 - "Community 31"
Cohesion: 0.83
Nodes (3): activateTab(), logout(), resetWizard()

### Community 34 - "Community 34"
Cohesion: 1.0
Nodes (1): Trigger a contact + group + profile pic backup.

### Community 35 - "Community 35"
Cohesion: 1.0
Nodes (1): Get backup stats and last backup info.

### Community 36 - "Community 36"
Cohesion: 1.0
Nodes (1): Export contacts as JSON or CSV.

### Community 37 - "Community 37"
Cohesion: 1.0
Nodes (1): Get a signed URL for a contact's profile picture.

### Community 38 - "Community 38"
Cohesion: 1.0
Nodes (1): Get the app_settings collection.

### Community 39 - "Community 39"
Cohesion: 1.0
Nodes (1): Default routing engine configuration.

### Community 40 - "Community 40"
Cohesion: 1.0
Nodes (1): Get the current routing engine configuration (super admin only).

### Community 41 - "Community 41"
Cohesion: 1.0
Nodes (1): Save routing engine configuration (super admin only).

### Community 42 - "Community 42"
Cohesion: 1.0
Nodes (1): Get all WA web sessions (super admin view).

### Community 43 - "Community 43"
Cohesion: 1.0
Nodes (1): Decorator to require login.

### Community 44 - "Community 44"
Cohesion: 1.0
Nodes (1): Check if WhatsApp Web sidecar is available.

### Community 45 - "Community 45"
Cohesion: 1.0
Nodes (1): Start OTP-based WhatsApp login.

### Community 46 - "Community 46"
Cohesion: 1.0
Nodes (1): Get current session status.

### Community 47 - "Community 47"
Cohesion: 1.0
Nodes (1): Disconnect WhatsApp session.

### Community 48 - "Community 48"
Cohesion: 1.0
Nodes (1): Send a personal message via WhatsApp Web session.     Falls back to Cloud API i

### Community 49 - "Community 49"
Cohesion: 1.0
Nodes (1): Get today's send statistics.

### Community 50 - "Community 50"
Cohesion: 1.0
Nodes (1): Trigger a contact + group + profile pic backup.

### Community 51 - "Community 51"
Cohesion: 1.0
Nodes (1): Export contacts as JSON or CSV.

### Community 52 - "Community 52"
Cohesion: 1.0
Nodes (1): Get a signed URL for a contact's profile picture.

### Community 53 - "Community 53"
Cohesion: 1.0
Nodes (1): Get the app_settings collection.

### Community 54 - "Community 54"
Cohesion: 1.0
Nodes (1): Default routing engine configuration.

### Community 55 - "Community 55"
Cohesion: 1.0
Nodes (1): Get the current routing engine configuration (super admin only).

### Community 56 - "Community 56"
Cohesion: 1.0
Nodes (1): Get all WA web sessions (super admin view).

### Community 57 - "Community 57"
Cohesion: 1.0
Nodes (1): Map personId -> display name for resolving relationship links.

### Community 58 - "Community 58"
Cohesion: 1.0
Nodes (1): Normalise a relation label into a comparable key (e.g. 'Son(beta)' -> 'son').

### Community 59 - "Community 59"
Cohesion: 1.0
Nodes (1): Format a family member name with its relation, e.g. 'Tejas (Son(beta))'.

### Community 60 - "Community 60"
Cohesion: 1.0
Nodes (1): Return a list of CSV rows for one registration document.      ``selected_relat

### Community 61 - "Community 61"
Cohesion: 1.0
Nodes (1): Return True when the current session is a public session whose stored     accou

### Community 62 - "Community 62"
Cohesion: 1.0
Nodes (1): Decorator that restricts a view to campaigner sessions. Any non-campaigner

### Community 63 - "Community 63"
Cohesion: 1.0
Nodes (1): Return the configured default account type for new mobile signups.      Reads

### Community 64 - "Community 64"
Cohesion: 1.0
Nodes (1): Mobile (OTP) login is available unless the active provider is disabled.

### Community 65 - "Community 65"
Cohesion: 1.0
Nodes (1): Look up a public_account by its 10-digit mobile, tolerating legacy formats.

### Community 66 - "Community 66"
Cohesion: 1.0
Nodes (1): Return the stored role config merged over defaults.

### Community 67 - "Community 67"
Cohesion: 1.0
Nodes (1): Check whether a role has a capability per the configurable matrix.

### Community 68 - "Community 68"
Cohesion: 1.0
Nodes (1): Return the app's MongoDB database instance via the registrations collection.

### Community 69 - "Community 69"
Cohesion: 1.0
Nodes (1): Return the 'campaigns' MongoDB collection.

### Community 70 - "Community 70"
Cohesion: 1.0
Nodes (1): Return the 'campaign_payments' MongoDB collection.

### Community 71 - "Community 71"
Cohesion: 1.0
Nodes (1): Return the 'campaign_messages' MongoDB collection.

### Community 72 - "Community 72"
Cohesion: 1.0
Nodes (1): Validate whether a campaign status transition is permitted.      Args:

### Community 73 - "Community 73"
Cohesion: 1.0
Nodes (1): Normalize an Indian mobile number to WhatsApp format (91XXXXXXXXXX).      Stri

### Community 74 - "Community 74"
Cohesion: 1.0
Nodes (1): Resolve a salutation toggle answer into its display text.      Accepts one of

### Community 75 - "Community 75"
Cohesion: 1.0
Nodes (1): Replace placeholders in template variables with recipient data.      Recognize

### Community 76 - "Community 76"
Cohesion: 1.0
Nodes (1): Return the list of available WhatsApp ad templates for the campaign wizard.

### Community 77 - "Community 77"
Cohesion: 1.0
Nodes (1): Extract the English text from a bilingual {en, mr} field (or plain string).

### Community 78 - "Community 78"
Cohesion: 1.0
Nodes (1): Build a display name from firstName/middleName/lastName English parts.

### Community 79 - "Community 79"
Cohesion: 1.0
Nodes (1): Query registrations and return HOF (Head of Family) records for selection.

### Community 80 - "Community 80"
Cohesion: 1.0
Nodes (1): Return the total number of members in a family record.      A family's total i

### Community 81 - "Community 81"
Cohesion: 1.0
Nodes (1): Resolve selected registration ids into recipient dicts server-side.      Full

### Community 82 - "Community 82"
Cohesion: 1.0
Nodes (1): Compute available areas with family counts for the Area filter dropdown.

### Community 83 - "Community 83"
Cohesion: 1.0
Nodes (1): Return distinct surnameGroup values for the surname filter dropdown.      Quer

### Community 84 - "Community 84"
Cohesion: 1.0
Nodes (1): Return the configured Razorpay key secret.      Reads from the Flask app confi

### Community 85 - "Community 85"
Cohesion: 1.0
Nodes (1): Return True when both the Razorpay key id and secret are configured.      Used

### Community 86 - "Community 86"
Cohesion: 1.0
Nodes (1): Verify a Razorpay payment signature using HMAC-SHA256.      Razorpay signs the

### Community 87 - "Community 87"
Cohesion: 1.0
Nodes (1): Return the configured Razorpay key id.      Reads from the Flask app config fi

### Community 88 - "Community 88"
Cohesion: 1.0
Nodes (1): Build and return a Razorpay API client authenticated with the configured     ke

### Community 89 - "Community 89"
Cohesion: 1.0
Nodes (1): Create a Razorpay order for a campaign payment.      Args:         amount_pai

### Community 90 - "Community 90"
Cohesion: 1.0
Nodes (1): Create a campaign and its associated Razorpay payment order.      Validates th

### Community 91 - "Community 91"
Cohesion: 1.0
Nodes (1): Truncate an error description to at most 500 characters (Requirement 7.3).

### Community 92 - "Community 92"
Cohesion: 1.0
Nodes (1): Send one WhatsApp template message via the Meta Graph API v24.0.      POSTs a

### Community 93 - "Community 93"
Cohesion: 1.0
Nodes (1): Return the 'app_settings' MongoDB collection (OTP / WhatsApp settings).

### Community 94 - "Community 94"
Cohesion: 1.0
Nodes (1): Load Meta WhatsApp delivery credentials from the settings collection.      Rea

### Community 95 - "Community 95"
Cohesion: 1.0
Nodes (1): Best-effort conversion of a value to ObjectId, returning the raw value     unch

### Community 96 - "Community 96"
Cohesion: 1.0
Nodes (1): Send a paid campaign's WhatsApp template messages to every recipient.      Cal

### Community 97 - "Community 97"
Cohesion: 1.0
Nodes (1): Return the configured Razorpay webhook secret.      Reads from the Flask app c

### Community 98 - "Community 98"
Cohesion: 1.0
Nodes (1): Verify a Razorpay webhook signature using HMAC-SHA256.      Razorpay signs eac

### Community 99 - "Community 99"
Cohesion: 1.0
Nodes (1): Process a Razorpay webhook delivery and trigger campaign execution.      Verif

### Community 100 - "Community 100"
Cohesion: 1.0
Nodes (1): Mask a mobile number so only the last 4 digits remain visible.      Every char

### Community 101 - "Community 101"
Cohesion: 1.0
Nodes (1): Return the UTC delivery-attempt timestamp for a campaign_message.      Prefers

### Community 102 - "Community 102"
Cohesion: 1.0
Nodes (1): Build a delivery report for a single campaign.      Aggregates the campaign_me

### Community 103 - "Community 103"
Cohesion: 1.0
Nodes (1): Unit tests for verify_razorpay_signature().  Covers valid/invalid HMAC-SHA256

## Knowledge Gaps
- **258 isolated node(s):** `Uses your existing Google-based transliteration endpoint logic.     Replace lat`, `Map personId -> display name for resolving relationship links.`, `Normalise a relation label into a comparable key (e.g. 'Son(beta)' -> 'son').`, `Format a family member name with its relation, e.g. 'Tejas (Son(beta))'.`, `Return a list of CSV rows for one registration document.      ``selected_relat` (+253 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 27`** (13 nodes): `CampaignReportEndpointTests`, `._login()`, `.setUp()`, `.test_invalid_campaign_id_returns_404()`, `.test_other_campaigner_cannot_view_returns_404()`, `.test_registrant_blocked_with_403()`, `.test_report_masks_mobile_numbers()`, `.test_report_stats_aggregation()`, `.test_unauthenticated_blocked_with_403()`, `.test_unknown_campaign_returns_404()`, `._url()`, `Tests for the GET /api/campaigns/<id>/report endpoint.  Covers @require_campai`, `test_campaign_report_endpoint.py`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 34`** (1 nodes): `Trigger a contact + group + profile pic backup.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 35`** (1 nodes): `Get backup stats and last backup info.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 36`** (1 nodes): `Export contacts as JSON or CSV.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (1 nodes): `Get a signed URL for a contact's profile picture.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 38`** (1 nodes): `Get the app_settings collection.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 39`** (1 nodes): `Default routing engine configuration.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 40`** (1 nodes): `Get the current routing engine configuration (super admin only).`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (1 nodes): `Save routing engine configuration (super admin only).`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (1 nodes): `Get all WA web sessions (super admin view).`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (1 nodes): `Decorator to require login.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (1 nodes): `Check if WhatsApp Web sidecar is available.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (1 nodes): `Start OTP-based WhatsApp login.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (1 nodes): `Get current session status.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (1 nodes): `Disconnect WhatsApp session.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (1 nodes): `Send a personal message via WhatsApp Web session.     Falls back to Cloud API i`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (1 nodes): `Get today's send statistics.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (1 nodes): `Trigger a contact + group + profile pic backup.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 51`** (1 nodes): `Export contacts as JSON or CSV.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 52`** (1 nodes): `Get a signed URL for a contact's profile picture.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 53`** (1 nodes): `Get the app_settings collection.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (1 nodes): `Default routing engine configuration.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 55`** (1 nodes): `Get the current routing engine configuration (super admin only).`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (1 nodes): `Get all WA web sessions (super admin view).`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 57`** (1 nodes): `Map personId -> display name for resolving relationship links.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 58`** (1 nodes): `Normalise a relation label into a comparable key (e.g. 'Son(beta)' -> 'son').`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 59`** (1 nodes): `Format a family member name with its relation, e.g. 'Tejas (Son(beta))'.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 60`** (1 nodes): `Return a list of CSV rows for one registration document.      ``selected_relat`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 61`** (1 nodes): `Return True when the current session is a public session whose stored     accou`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 62`** (1 nodes): `Decorator that restricts a view to campaigner sessions. Any non-campaigner`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 63`** (1 nodes): `Return the configured default account type for new mobile signups.      Reads`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 64`** (1 nodes): `Mobile (OTP) login is available unless the active provider is disabled.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 65`** (1 nodes): `Look up a public_account by its 10-digit mobile, tolerating legacy formats.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 66`** (1 nodes): `Return the stored role config merged over defaults.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 67`** (1 nodes): `Check whether a role has a capability per the configurable matrix.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 68`** (1 nodes): `Return the app's MongoDB database instance via the registrations collection.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 69`** (1 nodes): `Return the 'campaigns' MongoDB collection.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 70`** (1 nodes): `Return the 'campaign_payments' MongoDB collection.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 71`** (1 nodes): `Return the 'campaign_messages' MongoDB collection.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 72`** (1 nodes): `Validate whether a campaign status transition is permitted.      Args:`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 73`** (1 nodes): `Normalize an Indian mobile number to WhatsApp format (91XXXXXXXXXX).      Stri`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 74`** (1 nodes): `Resolve a salutation toggle answer into its display text.      Accepts one of`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 75`** (1 nodes): `Replace placeholders in template variables with recipient data.      Recognize`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 76`** (1 nodes): `Return the list of available WhatsApp ad templates for the campaign wizard.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 77`** (1 nodes): `Extract the English text from a bilingual {en, mr} field (or plain string).`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 78`** (1 nodes): `Build a display name from firstName/middleName/lastName English parts.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 79`** (1 nodes): `Query registrations and return HOF (Head of Family) records for selection.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 80`** (1 nodes): `Return the total number of members in a family record.      A family's total i`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 81`** (1 nodes): `Resolve selected registration ids into recipient dicts server-side.      Full`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 82`** (1 nodes): `Compute available areas with family counts for the Area filter dropdown.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 83`** (1 nodes): `Return distinct surnameGroup values for the surname filter dropdown.      Quer`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 84`** (1 nodes): `Return the configured Razorpay key secret.      Reads from the Flask app confi`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 85`** (1 nodes): `Return True when both the Razorpay key id and secret are configured.      Used`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 86`** (1 nodes): `Verify a Razorpay payment signature using HMAC-SHA256.      Razorpay signs the`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 87`** (1 nodes): `Return the configured Razorpay key id.      Reads from the Flask app config fi`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 88`** (1 nodes): `Build and return a Razorpay API client authenticated with the configured     ke`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 89`** (1 nodes): `Create a Razorpay order for a campaign payment.      Args:         amount_pai`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 90`** (1 nodes): `Create a campaign and its associated Razorpay payment order.      Validates th`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 91`** (1 nodes): `Truncate an error description to at most 500 characters (Requirement 7.3).`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 92`** (1 nodes): `Send one WhatsApp template message via the Meta Graph API v24.0.      POSTs a`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 93`** (1 nodes): `Return the 'app_settings' MongoDB collection (OTP / WhatsApp settings).`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 94`** (1 nodes): `Load Meta WhatsApp delivery credentials from the settings collection.      Rea`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 95`** (1 nodes): `Best-effort conversion of a value to ObjectId, returning the raw value     unch`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 96`** (1 nodes): `Send a paid campaign's WhatsApp template messages to every recipient.      Cal`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 97`** (1 nodes): `Return the configured Razorpay webhook secret.      Reads from the Flask app c`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 98`** (1 nodes): `Verify a Razorpay webhook signature using HMAC-SHA256.      Razorpay signs eac`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 99`** (1 nodes): `Process a Razorpay webhook delivery and trigger campaign execution.      Verif`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 100`** (1 nodes): `Mask a mobile number so only the last 4 digits remain visible.      Every char`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 101`** (1 nodes): `Return the UTC delivery-attempt timestamp for a campaign_message.      Prefers`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 102`** (1 nodes): `Build a delivery report for a single campaign.      Aggregates the campaign_me`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 103`** (1 nodes): `Unit tests for verify_razorpay_signature().  Covers valid/invalid HMAC-SHA256`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `FakeDatabase` connect `Community 0` to `Community 1`, `Community 8`, `Community 10`, `Community 12`, `Community 14`, `Community 15`, `Community 20`, `Community 23`, `Community 27`, `Community 29`?**
  _High betweenness centrality (0.156) - this node is a cross-community bridge._
- **Why does `send_single_template_message()` connect `Community 7` to `Community 1`, `Community 2`, `Community 21`?**
  _High betweenness centrality (0.155) - this node is a cross-community bridge._
- **Why does `execute_campaign_send()` connect `Community 1` to `Community 0`, `Community 3`, `Community 7`, `Community 8`, `Community 9`, `Community 14`?**
  _High betweenness centrality (0.127) - this node is a cross-community bridge._
- **Are the 159 inferred relationships involving `FakeDatabase` (e.g. with `GetRedirectForAccountTests` and `VerifyOtpRoutingTests`) actually correct?**
  _`FakeDatabase` has 159 INFERRED edges - model-reasoned connections that need verification._
- **Are the 44 inferred relationships involving `normalize_wa_number()` (e.g. with `.test_plain_10_digit_number()` and `.test_with_plus_91_prefix()`) actually correct?**
  _`normalize_wa_number()` has 44 INFERRED edges - model-reasoned connections that need verification._
- **Are the 36 inferred relationships involving `resolve_body_vars()` (e.g. with `test_output_length_equals_input_length()` and `test_output_entries_are_all_strings()`) actually correct?**
  _`resolve_body_vars()` has 36 INFERRED edges - model-reasoned connections that need verification._
- **Are the 29 inferred relationships involving `FakeCollection` (e.g. with `CreateCampaignWithUpiTests` and `SubmitUpiReferenceTests`) actually correct?**
  _`FakeCollection` has 29 INFERRED edges - model-reasoned connections that need verification._