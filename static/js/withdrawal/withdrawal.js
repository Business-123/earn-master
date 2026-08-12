(function () {
  const LS = window.LevelSystem;
  if (!LS) return;

  let verificationPromptShown = false;
  let verificationPaymentInFlight = false;

  function ensureWithdrawalShell() {
    const page = document.getElementById("withdrawalPage");
    if (!page) return null;

    page.innerHTML = `
     <div class="wHeader">
        <div>
          <div class="wTitle">Withdraw Funds</div>
          <div class="wSub">Minimum withdrawal amount is 50 GHS.</div>
        </div>
      </div>

      <div id="withdrawNoticeMount"></div>

      <div class="wFormCard">
        <div class="wFormTitle">
          <i class="fas fa-arrow-right-arrow-left"></i>
          Withdrawal Details
        </div>

        <div class="form-group">
  <label>Withdrawal Method</label>
  <select id="withdrawMethodSelectNew" class="wSelect"></select>

  <div style="display:flex; gap:8px; margin-top:10px;">
    <button id="withdrawAddMethodBtnNew" type="button" class="wAddMethodBtn" style="flex:1; margin-top:0;">
      <i class="fas fa-plus"></i> Add Method
    </button>
    <button id="withdrawDeleteMethodBtnNew" type="button" class="wAddMethodBtn" style="flex:1; margin-top:0; display:none;">
      <i class="fas fa-trash"></i> Delete
    </button>
  </div>
</div>

        <div class="form-group">
          <label>Enter Withdrawal Amount (GHS)</label>
          <input id="withdrawAmountNew" type="number" min="50" placeholder="e.g. 100" />
        </div>

        <button id="withdrawRequestBtnNew" class="btn-primary wWithdrawBtn">
          <i class="fas fa-paper-plane"></i> Request Withdrawal
        </button>

        <div id="withdrawErrorNew" class="error-message"></div>
      </div>

      <div class="wHistoryCard">
        <div class="wHistoryTitle">
          <i class="fas fa-clock-rotate-left"></i>
          Withdrawal History
        </div>
        <div id="withdrawHistoryListNew" class="wHistoryList"></div>
      </div>
    `;

    return page;
  }

  function renderHistorySkeleton() {
    const list = document.getElementById("withdrawHistoryListNew");
    if (!list) return;

    list.innerHTML = Array.from({ length: 4 })
      .map(
        () => `
          <div class="wHistoryRow">
            <div class="wHistLeft" style="width:100%;">
              <div class="ui-skeleton-line medium"></div>
              <div class="ui-skeleton-line short" style="margin-top:8px;"></div>
            </div>
            <div class="ui-skeleton-pill"></div>
          </div>
        `
      )
      .join("");
  }

function updateDeleteMethodButtonVisibility() {
  const deleteBtn = document.getElementById("withdrawDeleteMethodBtnNew");
  const select = document.getElementById("withdrawMethodSelectNew");
  if (!deleteBtn || !select) return;

  const hasValue = !!select.value;
  const hasMethods = Array.isArray(LS.state.withdrawal.methods) && LS.state.withdrawal.methods.length > 0;

  deleteBtn.style.display = hasMethods ? "inline-flex" : "none";
  deleteBtn.disabled = !hasValue;
  deleteBtn.style.opacity = hasValue ? "1" : "0.6";
}

  function renderMethodSelect() {
  const localMethods = LS.getSavedWithdrawalMethods();
  if (!Array.isArray(LS.state.withdrawal.methods) || !LS.state.withdrawal.methods.length) {
    LS.state.withdrawal.methods = localMethods;
  }

  const select = document.getElementById("withdrawMethodSelectNew");
  if (!select) return;

  const methods = LS.state.withdrawal.methods || [];

  if (!methods.length) {
    select.innerHTML = `<option value="">Select saved method</option>`;
    LS.state.withdrawal.selectedMethodId = "";
    updateDeleteMethodButtonVisibility();
    return;
  }

  select.innerHTML =
    `<option value="">Select saved method</option>` +
    methods
      .map((method, index) => {
        const shortNumber = String(method.number || "").slice(-4);
        return `
          <option value="${LS.escapeHtml(method.id)}">
            ${index + 1}. ${LS.escapeHtml(method.network)} • ****${LS.escapeHtml(shortNumber)} • ${LS.escapeHtml(method.name)}
          </option>
        `;
      })
      .join("");

  if (
    LS.state.withdrawal.selectedMethodId &&
    methods.some((m) => m.id === LS.state.withdrawal.selectedMethodId)
  ) {
    select.value = LS.state.withdrawal.selectedMethodId;
  } else {
    select.value = "";
    LS.state.withdrawal.selectedMethodId = "";
  }

  select.onchange = () => {
    LS.state.withdrawal.selectedMethodId = select.value || "";
    updateDeleteMethodButtonVisibility();
  };

  updateDeleteMethodButtonVisibility();
}

  function renderHistory(history) {
    const list = document.getElementById("withdrawHistoryListNew");
    if (!list) return;

   if (!history.length) {
      list.innerHTML = window.buildEmptyState
        ? window.buildEmptyState({
            icon: "💸",
            title: "No withdrawal requests yet",
            text: "Your submitted withdrawal requests will appear here once you make one.",
          })
        : `<div class="emptyState">No withdrawal requests yet.</div>`;
      return;
    }

    list.innerHTML = history
      .map((item) => {
        const badgeClass =
          item.status === "approved"
            ? "paid"
            : item.status === "pending"
              ? "pending"
              : "rejected";

        return `
          <div class="wHistoryRow">
            <div class="wHistLeft">
              <div class="wHistAmt">${LS.money(item.amount)} • ${LS.escapeHtml(item.network || "")}</div>
              <div class="wHistDate">${LS.escapeHtml(LS.formatDateTime ? LS.formatDateTime(item.created_at) : (item.created_at || ""))}</div>
            </div>
            <div class="wHistRight">
              <span class="wBadge ${badgeClass}">${LS.escapeHtml(item.status)}</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function setWithdrawError(message) {
    const err = document.getElementById("withdrawErrorNew");
    if (!err) return;

    if (!message) {
      err.textContent = "";
      err.classList.remove("show");
      return;
    }

    err.textContent = message;
    err.classList.add("show");
  }

async function loadMethods() {
    if (!LS.state.currentUser?.id) return [];

    const response = await LS.apiPost("/api/withdrawal-methods/list", {
      user_id: LS.state.currentUser.id,
    });

    const methods = Array.isArray(response.methods) ? response.methods : [];
    LS.state.withdrawal.methods = methods;

    try {
      const rawUser = JSON.parse(localStorage.getItem("currentUser") || "null");
      if (rawUser && rawUser.id === LS.state.currentUser.id) {
        rawUser.withdrawalMethods = methods;
        localStorage.setItem("currentUser", JSON.stringify(rawUser));
      }
    } catch (_) {}

    renderMethodSelect();
    return methods;
  }

  async function loadEligibility() {
    if (!LS.state.currentUser?.id) return null;

    const response = await LS.apiPost("/api/withdrawals/eligibility", {
      user_id: LS.state.currentUser.id,
    });

    LS.state.withdrawal.eligibility = response.eligibility;
    return response.eligibility;
  }

  async function loadHistory() {
    if (!LS.state.currentUser?.id) return [];

    const response = await LS.apiPost("/api/withdrawals/history", {
      user_id: LS.state.currentUser.id,
    });

    LS.state.withdrawal.history = response.history || [];
    renderHistory(LS.state.withdrawal.history);
    return LS.state.withdrawal.history;
  }

async function deleteSelectedMethod() {
  const methodId =
    LS.state.withdrawal.selectedMethodId ||
    document.getElementById("withdrawMethodSelectNew")?.value ||
    "";

  if (!methodId) {
    setWithdrawError("Please select a withdrawal method to delete.");
    return;
  }

  const method = (LS.state.withdrawal.methods || []).find((item) => item.id === methodId);
  if (!method) {
    setWithdrawError("Selected withdrawal method was not found.");
    return;
  }

  const confirmed = window.showConfirmModal
    ? await window.showConfirmModal({
        title: "Delete withdrawal method?",
        message: `${method.network} • ${method.number} — ${method.name}`,
        confirmText: "Delete",
        cancelText: "Cancel",
        danger: true,
      })
    : window.confirm(
        `Delete this withdrawal method?\n\n${method.network} • ${method.number}\n${method.name}`
      );
  if (!confirmed) return;

  const deleteBtn = document.getElementById("withdrawDeleteMethodBtnNew");
  if (window.setButtonLoading) {
    window.setButtonLoading(deleteBtn, true, "Deleting...");
  }

  try {
    const response = await LS.apiPost("/api/withdrawal-methods/delete", {
      user_id: LS.state.currentUser.id,
      method_id: methodId,
    });

    const methods = Array.isArray(response.methods) ? response.methods : [];
    LS.state.withdrawal.methods = methods;

    if (LS.state.currentUser) {
      LS.state.currentUser.withdrawalMethods = methods;
    }

    try {
      const rawUser = JSON.parse(localStorage.getItem("currentUser") || "null");
      if (rawUser && rawUser.id === LS.state.currentUser.id) {
        rawUser.withdrawalMethods = methods;
        localStorage.setItem("currentUser", JSON.stringify(rawUser));
      }
    } catch (_) {}

    LS.state.withdrawal.selectedMethodId = "";
    renderMethodSelect();
    setWithdrawError("");
    LS.toast(response.message || "Withdrawal method deleted.");
  } catch (error) {
    setWithdrawError(error.message);
  } finally {
    if (window.setButtonLoading) {
      window.setButtonLoading(deleteBtn, false);
    }
    updateDeleteMethodButtonVisibility();
  }
}

async function startVerificationFeePayment(feeAmount) {
  if (verificationPaymentInFlight) return;
  verificationPaymentInFlight = true;

  try {
    const callbackUrl = `${window.location.origin}/?wv_return=1`;

    const response = await LS.apiPost("/api/payments/withdrawal-verification/init", {
      user_id: LS.state.currentUser.id,
      callback_url: callbackUrl,
    });

    const payment = response.payment || {};

    if (payment.waived) {
      LS.toast("Verification fee waived. You're all set to withdraw.");
      await loadEligibility();
      return;
    }

    if (payment.authorization_url) {
      window.location.href = payment.authorization_url;
      return;
    }

    LS.toast("Could not start the verification payment. Please try again.");
  } catch (error) {
    LS.toast(error.message || "Could not start the verification payment.");
  } finally {
    verificationPaymentInFlight = false;
  }
}

async function promptVerificationFeePayment(eligibility) {
  const feeAmount = Number(eligibility?.verification_fee_amount || 0);

  const confirmed = window.showConfirmModal
    ? await window.showConfirmModal({
        title: "One-time verification required",
        message: `Before your first withdrawal, a one-time verification fee of ${LS.money(feeAmount)} is required. You'll only ever pay this once.`,
        confirmText: `Pay ${LS.money(feeAmount)} Now`,
        cancelText: "Not now",
      })
    : window.confirm(
        `A one-time verification fee of ${LS.money(feeAmount)} is required before you can withdraw. Pay now?`
      );

  if (!confirmed) return;

  await startVerificationFeePayment(feeAmount);
}

async function submitWithdrawalRequest() {
  const requestBtn = document.getElementById("withdrawRequestBtnNew");

  if (window.setButtonLoading) {
    window.setButtonLoading(requestBtn, true, "Submitting...");
  }

  try {
    const eligibility = LS.state.withdrawal.eligibility || (await loadEligibility());

    if (!eligibility?.can_withdraw) {
      if (eligibility?.reason_code === "verification_fee_required") {
        if (window.setButtonLoading) {
          window.setButtonLoading(requestBtn, false);
        }
        await promptVerificationFeePayment(eligibility);
        return;
      }
      throw new Error(eligibility?.message || "Withdrawal is currently blocked.");
    }

    const amount = Number(document.getElementById("withdrawAmountNew")?.value || 0);
    const methodId =
      LS.state.withdrawal.selectedMethodId ||
      document.getElementById("withdrawMethodSelectNew")?.value ||
      "";

    if (!methodId) {
      throw new Error("Please select a withdrawal method.");
    }

    const method = (LS.state.withdrawal.methods || []).find((item) => item.id === methodId);
    if (!method) {
      throw new Error("Selected withdrawal method was not found.");
    }

const confirmed = window.showConfirmModal
        ? await window.showConfirmModal({
            title: "Request withdrawal?",
            message: `You are about to request ${LS.money(amount)} to ${method.network} (${method.number}). This request will be sent for manual approval.`,
            confirmText: "Request Withdrawal",
            cancelText: "Cancel",
          })
        : true;

      if (!confirmed) {
        if (window.setButtonLoading) {
          window.setButtonLoading(requestBtn, false);
        }
        return;
      }

    const response = await LS.apiPost("/api/withdrawals/request", {
      user_id: LS.state.currentUser.id,
      amount,
      method_id: method.id,
      network: method.network,
      number: method.number,
      name: method.name,
    });

    setWithdrawError("");
    document.getElementById("withdrawAmountNew").value = "";

    if (window.setUiNotice) {
        window.setUiNotice({
          page: "withdrawal",
          tone: "success",
          title: "Withdrawal requested",
          message: "Your request has been submitted and is now pending manual approval.",
        });
      }

      if (window.flashButtonSuccess) {
        window.flashButtonSuccess(requestBtn, "Requested", 800);
      }

      LS.toast(response.message || "Withdrawal request submitted.");

      const reservedBalance = Number(response?.request?.balance_after);
      if (Number.isFinite(reservedBalance) && LS.state.currentUser) {
        LS.state.currentUser.balance = reservedBalance;
        try {
          const rawUser = JSON.parse(localStorage.getItem("currentUser") || "null");
          if (rawUser && rawUser.id === LS.state.currentUser.id) {
            rawUser.balance = reservedBalance;
            localStorage.setItem("currentUser", JSON.stringify(rawUser));
          }
        } catch (_) {}
        if (typeof window.updateMePage === "function") {
          window.updateMePage();
        }
      }

      if (window.refreshMessagesFromServer) {
        window.refreshMessagesFromServer({ force: false }).catch(() => null);
      }

      if (window.mountUiNotice) {
        window.mountUiNotice("withdrawNoticeMount", "withdrawal");
      }

      if (window.refreshMessagesFromServer) {
        await window.refreshMessagesFromServer({ force: false }).catch(() => null);
      }

    await loadHistory();
    await loadEligibility();

  } catch (error) {
    setWithdrawError(error.message);
  } finally {
    if (window.setButtonLoading) {
      window.setButtonLoading(requestBtn, false);
    }
  }
}

  function init(options = {}) {
    const { promptVerification = false } = options;
    ensureWithdrawalShell();

    if (window.mountUiNotice) {
      window.mountUiNotice("withdrawNoticeMount", "withdrawal");
    }

    renderHistorySkeleton();

    if (!LS.state.currentUser?.id) return;

    loadMethods().catch((error) => setWithdrawError(error.message));

    const requestBtn = document.getElementById("withdrawRequestBtnNew");
    if (requestBtn && !requestBtn.dataset.bound) {
      requestBtn.dataset.bound = "1";
      requestBtn.addEventListener("click", submitWithdrawalRequest);
    }

    const addMethodBtn = document.getElementById("withdrawAddMethodBtnNew");
    if (addMethodBtn && !addMethodBtn.dataset.bound) {
      addMethodBtn.dataset.bound = "1";
      addMethodBtn.addEventListener("click", () => {
        if (typeof window.showAddMethodModal === "function") {
          window.showAddMethodModal();
        } else {
          LS.toast("Use your account settings to add a withdrawal method.");
        }
      });
    }

    const deleteMethodBtn = document.getElementById("withdrawDeleteMethodBtnNew");
if (deleteMethodBtn && !deleteMethodBtn.dataset.bound) {
  deleteMethodBtn.dataset.bound = "1";
  deleteMethodBtn.addEventListener("click", deleteSelectedMethod);
}

    loadEligibility()
      .then((eligibility) => {
        if (
          promptVerification &&
          eligibility?.reason_code === "verification_fee_required" &&
          !verificationPromptShown
        ) {
          verificationPromptShown = true;
          promptVerificationFeePayment(eligibility);
        }
      })
      .catch((error) => setWithdrawError(error.message));
    loadHistory().catch((error) => setWithdrawError(error.message));
  }

  async function handleWithdrawalVerificationReturn() {
    const params = new URLSearchParams(window.location.search);
    const isReturn = params.get("wv_return");
    const reference =
      params.get("reference") ||
      params.get("trxref") ||
      params.get("payment_reference");

    if (!isReturn) return;

    history.replaceState({}, document.title, window.location.pathname);

    if (!reference || !LS.state.currentUser?.id) return;

    try {
      const response = await LS.apiPost("/api/payments/withdrawal-verification/verify", {
        reference,
      });

      if (response.success) {
        LS.toast(response.message || "Verification fee paid. You can now withdraw.");
      } else {
        LS.toast(response.message || "We could not verify this payment yet.");
      }
    } catch (error) {
      LS.toast(error.message || "We could not verify this payment yet.");
    } finally {
      await loadEligibility().catch(() => null);
    }
  }

  window.LevelSystem.withdrawal = {
    init,
    loadMethods,
    loadEligibility,
    handleWithdrawalVerificationReturn,
  };

  document.addEventListener("DOMContentLoaded", () => {
    handleWithdrawalVerificationReturn();
  });
})();
