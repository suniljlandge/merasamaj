"""
Admin data tools, exposed in-app (admin / super_admin):

  1. Address bifurcation  - classify each registration into a Washim locality
     from its address, plus a cleaned (spell-corrected) address suggestion.

  2. Transliteration fixer - find English name words whose stored Marathi is not
     a valid transliteration (e.g. "रॅक" for "Ramkumar"), let an admin pick the
     correct spelling (data variants + Google suggestions), and save it into the
     `transliteration_corrections` collection so future registrations auto-fix.

All Google lookups reuse samaj.transliterate (Google Input Tools, no API key)
and are cached in-process.
"""

import re
from collections import Counter, defaultdict

from .transliterate import transliteration_suggestions, clean_text

# ---------------------------------------------------------------------------
# Address cleanup (Hinglish) + area classification
# ---------------------------------------------------------------------------
WORD_FIXES = {
    "leout": "Layout", "layout": "Layout",
    "appartment": "Apartment", "apparment": "Apartment", "apartment": "Apartment",
    "colny": "Colony", "colony": "Colony",
    "rod": "Road", "raod": "Road", "road": "Road",
    "naka": "Naka", "nagar": "Nagar", "peth": "Peth",
    "bajar": "Bazar", "bazar": "Bazar", "bazaar": "Bazar",
    "infrant": "In Front", "infront": "In Front", "infornt": "In Front",
    "nr": "Near", "near": "Near",
    "hoptical": "Hospital", "hopital": "Hospital", "hospital": "Hospital",
    "mandir": "Mandir", "flot": "Flat", "falt": "Flat", "flat": "Flat",
    "washim": "Washim", "waahim": "Washim", "wahim": "Washim",
    "lakhala": "Lakhala", "lakhaka": "Lakhala", "lakahala": "Lakhala", "lakhalaa": "Lakhala",
    "iudp": "IUDP", "iupd": "IUDP",
    "shukrawar": "Shukrawar", "shrukrawar": "Shukrawar",
    "mahurvesh": "Mahurvesh", "mahurwesh": "Mahurvesh",
    "gurwar": "Gurwar", "guruwar": "Gurwar", "gurvar": "Gurwar",
    "tirupati": "Tirupati", "dreamland": "Dreamland",
    "kativesh": "Kativesh", "katiwesh": "Kativesh",
    "ke": "Ke", "pas": "Pas", "paas": "Pas", "pass": "Pas",
}
UPPER_TOKENS = {"IUDP", "LIC", "SBI", "SDP", "DYSP", "CA", "C/O", "RTO",
                "H", "K", "G", "F", "J", "C", "A", "B"}
LOWER_JOINERS = {"of", "to", "ke", "near", "the", "and"}

AREA_RULES = [
    ("Kata", ["kata"]),
    ("Tondgaon", ["tondgaon", "tondga"]),
    ("Ansingh", ["ansingh"]),
    ("Kondala Zamare", ["kondala"]),
    ("Tirupati City (Akola Road)", ["tirupati"]),
    ("Dreamland City", ["dreamland"]),
    ("Mantri Park", ["mantri park", "suncity mantri"]),
    ("Riddhisiddhi Apartment (Lakhala)", ["riddhisiddhi", "riddhi siddhi", "ridi sidi"]),
    ("Chandak Layout (Lakhala)", ["chandak"]),
    ("Shukrawar Peth / Baheti Galli", ["shukrawar", "shrukrawar", "baheti galli", "mahurvesh", "mahurwesh"]),
    ("Gurwar Bazar / Shiv Chowk", ["gurwar", "guruwar", "gurvar", "shiv chowk", "ganesh peth", "nagina"]),
    ("Lal Bahadur Shastri Colony (Lakhala)", ["lal bahadur", "lal bahadhur"]),
    ("Green Park Colony", ["green park", "grin park", "greenpark"]),
    ("Giriraj Colony (Lakhala)", ["giriraj"]),
    ("Madhav Nagar (Lakhala)", ["madhav nagar"]),
    ("Professor Colony (Lakhala)", ["professor colony"]),
    ("Ambika Nagar (Lakhala)", ["ambika nagar"]),
    ("Kale File (Lakhala)", ["kale file", "kale fail", "kale lay", "khule layout"]),
    ("Gade Layout (Lakhala)", ["gade lay", "gade-lay", "gade layout", "kasturi gade"]),
    ("Civil Lines", ["civil line", "civil lines"]),
    ("Dev Peth", ["devpeth", "dev peth", "deopeth", "deo peth", "dev lay"]),
    ("Patni Chowk", ["patni chowk", "patani chok"]),
    ("Kativesh", ["kativesh", "katiwesh", "balu chowk", "sarafa galli"]),
    ("Ishwari Colony / Residency", ["ishwari", "ishawari"]),
    ("Santoshi Mata Nagar (Akola Naka)", ["santoshi mata"]),
    ("Hingoli Naka", ["hingoli naka", "gulati layout"]),
    ("Akola Naka / Akola Road", ["akola naka", "akola road", "akola rod"]),
    ("Pusad Naka", ["pusad naka", "pusada naka"]),
    ("Jawahar Colony (IUDP)", ["jawahar", "jawhar", "jawar colony", "jawar colny"]),
    ("IUDP Colony", ["iudp", "iupd", "i u d p"]),
    ("Lakhala (other)", ["lakhala", "lakhaka", "lakahala", "lakhalaa", "risod road"]),
    ("Washim (other)", ["washim", "waahim", "wahim"]),
]


def _fix_token(tok):
    m = re.match(r"^([\W_]*)(.*?)([\W_]*)$", tok, re.UNICODE)
    lead, core, trail = m.group(1), m.group(2), m.group(3)
    if not core:
        return tok
    low = core.lower()
    if low in WORD_FIXES:
        fixed = WORD_FIXES[low]
    elif core.upper() in UPPER_TOKENS:
        fixed = core.upper()
    else:
        fixed = core[:1].upper() + core[1:].lower()
    return f"{lead}{fixed}{trail}"


def clean_address(text):
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\ble\s*out\b", "Layout", text, flags=re.IGNORECASE)
    text = re.sub(r"\blay\s*out\b", "Layout", text, flags=re.IGNORECASE)
    text = re.sub(r"\bi\s*u\s*d\s*p\b", "IUDP", text, flags=re.IGNORECASE)
    text = re.sub(r"\briddhi\s*siddhi\b", "Riddhisiddhi", text, flags=re.IGNORECASE)
    tokens = text.split(" ")
    out = []
    for i, tok in enumerate(tokens):
        ft = _fix_token(tok)
        if i > 0 and ft.lower() in LOWER_JOINERS:
            ft = ft.lower()
        out.append(ft)
    return " ".join(out)


def classify_area(addr1, addr2):
    blob = re.sub(r"\s+", " ", f"{addr1} {addr2}".lower())
    for area, keywords in AREA_RULES:
        for kw in keywords:
            if kw in blob:
                return area
    return "Unclassified"


def _addr_en(doc, key):
    val = doc.get(key) or {}
    return clean_text(val.get("en") if isinstance(val, dict) else val)


def address_report(documents):
    """Return (groups, summary). groups: area -> list of row dicts."""
    groups = defaultdict(list)
    for doc in documents:
        a1 = _addr_en(doc, "address1")
        a2 = _addr_en(doc, "address2")
        area = classify_area(a1, a2)
        groups[area].append({
            "id": str(doc.get("_id", "")),
            "name": _person_label(doc),
            "name_mr": _person_label_mr(doc),
            "mobile": clean_text(doc.get("mobileNumber")),
            "address1_clean": clean_address(a1),
            "address2_clean": clean_address(a2),
            "address1_raw": a1,
            "address2_raw": a2,
            "address1_mr": _addr_mr(doc, "address1"),
            "address2_mr": _addr_mr(doc, "address2"),
            "district": clean_text(doc.get("district")),
            "taluka": clean_text(doc.get("taluka")),
            "state": clean_text(doc.get("state")),
            "surname": clean_text(doc.get("surnameGroup")),
            "members": doc.get("membersCount", 0),
            "createdBy": clean_text(doc.get("createdBy")),
        })
    summary = sorted(
        ({"area": a, "families": len(rows),
          "members": sum(int(r["members"] or 0) for r in rows)}
         for a, rows in groups.items()),
        key=lambda x: x["families"], reverse=True,
    )
    return groups, summary


def _person_label(doc):
    def en(k):
        v = doc.get(k) or {}
        return v.get("en", "") if isinstance(v, dict) else ""
    return clean_text(" ".join(p for p in [en("firstName"), en("middleName"), en("lastName")] if p))


def _person_label_mr(doc):
    def mr(k):
        v = doc.get(k) or {}
        return v.get("mr", "") if isinstance(v, dict) else ""
    return clean_text(" ".join(p for p in [mr("firstName"), mr("middleName"), mr("lastName")] if p))


def _addr_mr(doc, key):
    val = doc.get(key) or {}
    return clean_text(val.get("mr") if isinstance(val, dict) else "")


# ---------------------------------------------------------------------------
# Transliteration analysis
# ---------------------------------------------------------------------------
_SUGGEST_CACHE = {}


def suggest_cached(word):
    key = (word or "").strip().lower()
    if not key:
        return []
    if key not in _SUGGEST_CACHE:
        _SUGGEST_CACHE[key] = transliteration_suggestions(key) or []
    return _SUGGEST_CACHE[key]


def _en_word_key(token):
    core = re.sub(r"[^\w]", "", token, flags=re.UNICODE).lower()
    if core.endswith("ji") and len(core) > 4:
        core = core[:-2]
    return core


def _strip_mr_ji(tok):
    if tok.endswith("जी") and len(tok) > 2:
        return tok[:-2], True
    return tok, False


def _process_field(stats, unaligned, value, doc_id, label, field):
    en = clean_text(value.get("en"))
    mr = clean_text(value.get("mr"))
    if not en:
        return
    en_words = en.split()
    mr_words = mr.split()
    if len(en_words) != len(mr_words):
        unaligned.append({
            "id": doc_id, "label": label, "field": field, "en": en, "mr": mr,
        })
        return
    for e, m in zip(en_words, mr_words):
        ek = _en_word_key(e)
        base, _ = _strip_mr_ji(m)
        if ek and base:
            stats[ek][base] += 1


BILINGUAL_NAME_FIELDS = ("firstName", "middleName", "lastName")


def collect_stats(documents):
    """Fast, local pass (no network): returns (stats, unaligned).
    stats: en_word_key -> Counter of Marathi base spellings."""
    stats = defaultdict(Counter)
    unaligned = []
    for doc in documents:
        doc_id = str(doc.get("_id", ""))
        label = _person_label(doc)
        for field in BILINGUAL_NAME_FIELDS:
            val = doc.get(field) or {}
            if isinstance(val, dict):
                _process_field(stats, unaligned, val, doc_id, label, field)
        for index, member in enumerate(doc.get("familyMembers") or []):
            for name_field in ("name", "spouseName"):
                val = member.get(name_field) or {}
                if isinstance(val, dict):
                    _process_field(
                        stats, unaligned, val, doc_id, label,
                        f"familyMembers.{index}.{name_field}",
                    )
    return stats, unaligned


def words_needing_lookup(stats, unaligned, overrides):
    """Distinct English word keys whose Google suggestion is required and not
    yet cached / overridden."""
    words = set(stats.keys())
    for item in unaligned:
        for w in item["en"].split():
            ek = _en_word_key(w)
            if ek:
                words.add(ek)
    return sorted(
        w for w in words
        if w and w not in overrides and w not in _SUGGEST_CACHE
    )


def fetch_one(word):
    """Fetch (uncached) Google suggestions for one word and store in cache."""
    key = (word or "").strip().lower()
    if not key:
        return []
    result = transliteration_suggestions(key) or []
    _SUGGEST_CACHE[key] = result
    return result


def phrase_suggestion(en, overrides):
    """Build a full-phrase Marathi suggestion from cache + overrides."""
    out = []
    for w in en.split():
        ek = _en_word_key(w)
        if ek in overrides:
            out.append(overrides[ek])
        else:
            suggs = _SUGGEST_CACHE.get(ek) or []
            out.append(suggs[0] if suggs else w)
    return " ".join(out)


def finalize_suspects(stats, overrides):
    suspects = []
    ok_count = 0
    for ek, counter in stats.items():
        if ek in overrides:
            ok_count += 1
            continue
        suggs = suggest_cached(ek)
        top, _ = counter.most_common(1)[0]
        if suggs and top in suggs:
            ok_count += 1
            continue
        if (any(m not in suggs for m in counter)) or not suggs:
            suspects.append({
                "word": ek,
                "options": _build_options(ek, counter),
                "count": sum(counter.values()),
            })
        else:
            ok_count += 1
    suspects.sort(key=lambda s: (-s["count"], s["word"]))
    return suspects, ok_count


def analyze_names(documents, overrides):
    """Synchronous full analysis (used by the non-streaming endpoint)."""
    stats, unaligned = collect_stats(documents)
    suspects, ok_count = finalize_suspects(stats, overrides)
    for item in unaligned:
        item["suggestion"] = phrase_suggestion(item["en"], overrides)
    return {
        "suspects": suspects,
        "distinctWords": len(stats),
        "okWords": ok_count,
        "unaligned": unaligned,
    }


def _build_options(key, counter):
    options = [{"spelling": sp, "source": f"in data x{c}"}
               for sp, c in counter.most_common()]
    seen = {o["spelling"] for o in options}
    for s in suggest_cached(key):
        if s not in seen:
            options.append({"spelling": s, "source": "google"})
            seen.add(s)
    return options


# ---------------------------------------------------------------------------
# Fast, local, surgical apply (no network) — only replaces words that have a
# saved correction, leaving every other token exactly as entered.
# ---------------------------------------------------------------------------
APPLY_FIELDS = ("firstName", "middleName", "lastName")


def _apply_overrides_to_field(value, overrides):
    """Return a new Marathi string if any word changed, else None."""
    if not isinstance(value, dict):
        return None
    en = clean_text(value.get("en"))
    mr = clean_text(value.get("mr"))
    if not en or not mr:
        return None
    en_words = en.split()
    mr_words = mr.split()
    if len(en_words) != len(mr_words):
        return None  # can't align safely -> leave untouched
    changed = False
    out = []
    for e, m in zip(en_words, mr_words):
        ek = _en_word_key(e)
        base, had_ji = _strip_mr_ji(m)
        if ek in overrides and base != overrides[ek]:
            out.append(overrides[ek] + ("जी" if had_ji else ""))
            changed = True
        else:
            out.append(m)
    return " ".join(out) if changed else None


def apply_overrides_to_doc(doc, overrides):
    """Return a dict of changed fields ($set payload), or {} if nothing changed."""
    changes = {}
    for field in APPLY_FIELDS:
        new_mr = _apply_overrides_to_field(doc.get(field), overrides)
        if new_mr is not None:
            value = dict(doc.get(field) or {})
            value["mr"] = new_mr
            changes[field] = value

    members = doc.get("familyMembers") or []
    members_changed = False
    new_members = []
    for member in members:
        member_copy = dict(member)
        for name_field in ("name", "spouseName"):
            new_mr = _apply_overrides_to_field(member.get(name_field), overrides)
            if new_mr is not None:
                value = dict(member.get(name_field) or {})
                value["mr"] = new_mr
                member_copy[name_field] = value
                members_changed = True
        new_members.append(member_copy)
    if members_changed:
        changes["familyMembers"] = new_members

    return changes
