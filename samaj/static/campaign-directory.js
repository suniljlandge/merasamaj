/* ============================================================
 * Campaign Manager — Member Directory tab (Task 9.2)
 *
 * Read-only browsing of registered samaj HOF records for
 * campaigner users (Requirement 2.2).
 *
 * Reuses the existing directory data endpoint (/api/member-search),
 * the same one used by directory.js, so behaviour stays consistent:
 *   - text search "q" matches name + mobile number (server-side)
 *   - "district" / "taluka" filter the result set
 *   - paginated via "page" / "per_page"
 *
 * Displayed columns: name, mobile, district, taluka, area.
 * "Area" is shown from the member's locality (address1) text since
 * the stored documents do not carry a pre-computed area field.
 *
 * This module is wrapped in an IIFE and scoped to #cm-directory-root
 * so it never collides with campaign-manager.js (tab switching) or
 * the campaign wizard scripts.
 * ============================================================ */

(function () {
  "use strict";

  // District -> talukas hierarchy (mirrors directory.js LOCATION_DATA).
  var LOCATION_DATA = {
    Maharashtra: {
      Washim: ["Washim", "Malegaon", "Mangrulpir", "Karanja", "Risod", "Manora"],
      Amravati: ["Amravati", "Achalpur", "Chandur Railway", "Daryapur", "Morshi"],
      Akola: ["Akola", "Balapur", "Patur", "Murtizapur"],
      Buldhana: ["Buldhana", "Khamgaon", "Shegaon", "Malkapur"],
      Yavatmal: ["Yavatmal", "Darwha", "Pusad", "Umarkhed"],
    },
  };

  var PER_PAGE = 15;
  var currentPage = 1;

  // Resolved on init.
  var root, searchInput, districtSelect, talukaSelect, searchButton;
  var tableBody, countBadge, paginationEl;

  function init() {
    root = document.getElementById("cm-directory-root");
    if (!root) {
      // Directory tab is not present on this page; nothing to do.
      return;
    }

    searchInput = document.getElementById("cmd-search");
    districtSelect = document.getElementById("cmd-district");
    talukaSelect = document.getElementById("cmd-taluka");
    searchButton = document.getElementById("cmd-search-btn");
    tableBody = document.getElementById("cmd-tbody");
    countBadge = document.getElementById("cmd-count");
    paginationEl = document.getElementById("cmd-pagination");

    if (!tableBody) {
      return;
    }

    populateDistricts();
    wireEvents();
    loadMembers(1);
  }

  function populateDistricts() {
    var districts = Object.keys(LOCATION_DATA.Maharashtra);

    districtSelect.innerHTML =
      '<option value="">All districts</option>' +
      districts
        .map(function (d) {
          return '<option value="' + escapeAttr(d) + '">' + escapeHtml(d) + "</option>";
        })
        .join("");
  }

  function populateTalukas(district) {
    var talukas = LOCATION_DATA.Maharashtra[district] || [];

    talukaSelect.innerHTML =
      '<option value="">All talukas</option>' +
      talukas
        .map(function (t) {
          return '<option value="' + escapeAttr(t) + '">' + escapeHtml(t) + "</option>";
        })
        .join("");
  }

  function wireEvents() {
    searchButton.addEventListener("click", function () {
      loadMembers(1);
    });

    searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        loadMembers(1);
      }
    });

    districtSelect.addEventListener("change", function () {
      populateTalukas(districtSelect.value);
      loadMembers(1);
    });

    talukaSelect.addEventListener("change", function () {
      loadMembers(1);
    });
  }

  function loadMembers(page) {
    currentPage = Number(page) || 1;

    tableBody.innerHTML =
      '<tr><td colspan="6" class="px-4 py-10 text-center text-slate-500">' +
      "Loading members..." +
      "</td></tr>";

    var params = new URLSearchParams({
      q: searchInput.value || "",
      district: districtSelect.value || "",
      taluka: talukaSelect.value || "",
    });
    params.set("page", String(currentPage));
    params.set("per_page", String(PER_PAGE));

    fetch("/api/member-search?" + params.toString())
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Request failed with status " + response.status);
        }
        return response.json();
      })
      .then(function (body) {
        renderResults(body);
      })
      .catch(function (error) {
        console.error(error);
        tableBody.innerHTML =
          '<tr><td colspan="6" class="px-4 py-10 text-center text-red-500">' +
          "Failed to load members" +
          "</td></tr>";
        if (paginationEl) {
          paginationEl.innerHTML = "";
        }
      });
  }

  function renderResults(body) {
    var total = (body && body.total_count) || 0;
    var pageNum = (body && body.page) || currentPage;
    var pageSize = (body && body.per_page) || PER_PAGE;
    var items = (body && body.items) || [];

    if (countBadge) {
      countBadge.textContent =
        total + (total === 1 ? " member" : " members");
    }

    if (!items.length) {
      tableBody.innerHTML =
        '<tr><td colspan="6" class="px-4 py-10 text-center text-slate-500">' +
        "No members found" +
        "</td></tr>";
      renderPagination(total, pageNum, pageSize);
      return;
    }

    var startIndex = (pageNum - 1) * pageSize || 0;

    tableBody.innerHTML = items
      .map(function (record, index) {
        return renderRow(record, startIndex + index);
      })
      .join("");

    renderPagination(total, pageNum, pageSize);
  }

  function renderRow(record, index) {
    var name = joinName(record);
    var mobile = maskMobile(record.mobileNumber);
    var district = record.district || "-";
    var taluka = record.taluka || "-";
    var area = resolveArea(record);

    return (
      '<tr class="hover:bg-slate-50 transition">' +
      '<td class="px-4 py-3 text-slate-500 font-medium whitespace-nowrap">' +
      (index + 1) +
      "</td>" +
      '<td class="px-4 py-3 font-semibold whitespace-nowrap">' +
      escapeHtml(name) +
      "</td>" +
      '<td class="px-4 py-3 whitespace-nowrap">' +
      escapeHtml(mobile) +
      "</td>" +
      '<td class="px-4 py-3 whitespace-nowrap">' +
      escapeHtml(district) +
      "</td>" +
      '<td class="px-4 py-3 whitespace-nowrap">' +
      escapeHtml(taluka) +
      "</td>" +
      '<td class="px-4 py-3">' +
      escapeHtml(area) +
      "</td>" +
      "</tr>"
    );
  }

  function renderPagination(totalCount, page, perPage) {
    if (!paginationEl) {
      return;
    }

    if (!totalCount) {
      paginationEl.innerHTML = "";
      return;
    }

    var totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    var prevDisabled = page <= 1;
    var nextDisabled = page >= totalPages;

    paginationEl.innerHTML =
      '<div class="flex items-center gap-3">' +
      '<button id="cmd-prev" type="button" class="px-3 py-1 rounded-lg border text-sm ' +
      (prevDisabled ? "opacity-50 pointer-events-none" : "hover:bg-slate-50") +
      '">Prev</button>' +
      '<div class="text-sm text-slate-600">Page ' +
      page +
      " of " +
      totalPages +
      "</div>" +
      '<button id="cmd-next" type="button" class="px-3 py-1 rounded-lg border text-sm ' +
      (nextDisabled ? "opacity-50 pointer-events-none" : "hover:bg-slate-50") +
      '">Next</button>' +
      "</div>";

    var prevBtn = document.getElementById("cmd-prev");
    var nextBtn = document.getElementById("cmd-next");

    if (prevBtn) {
      prevBtn.addEventListener("click", function () {
        if (page > 1) {
          loadMembers(page - 1);
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", function () {
        if (page < totalPages) {
          loadMembers(page + 1);
        }
      });
    }
  }

  /* ---------------- helpers ---------------- */

  function joinName(record) {
    record = record || {};
    var parts = [
      bilingual(record.firstName),
      bilingual(record.middleName),
      bilingual(record.lastName),
    ].filter(Boolean);

    return parts.length ? parts.join(" ") : "-";
  }

  function bilingual(value) {
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    return value.en || value.mr || "";
  }

  // Show the member's locality/area text. Stored documents keep this in
  // address1 (the same field directory.js renders as the address column).
  function resolveArea(record) {
    record = record || {};
    var area = bilingual(record.area) || bilingual(record.address1);
    return area || "-";
  }

  function maskMobile(mobile) {
    mobile = String(mobile || "");
    if (mobile.length < 4) {
      return mobile || "-";
    }
    return "XXXXXX" + mobile.slice(-4);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[ch];
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  // Scripts are loaded with `defer`, so the DOM is ready, but guard anyway.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
