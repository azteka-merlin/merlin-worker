const SteamUser = require("steam-user");

const steam = new SteamUser({ autoRelogin: true, enablePicsCache: false });
let ready = false;
let loginPromise = null;

steam.on("loggedOn", () => { ready = true; });
steam.on("disconnected", () => { ready = false; });
steam.on("error", (error) => {
  ready = false;
  console.warn("[steam-depots] Steam session error", error.message);
});

function ensureLoggedOn() {
  if (ready) return Promise.resolve();
  if (!loginPromise) {
    loginPromise = new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        steam.off("loggedOn", onReady);
        steam.off("error", onError);
      };
      steam.once("loggedOn", onReady);
      steam.once("error", onError);
      steam.logOn({ anonymous: true });
    }).finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

function applicablePublicDepots(info) {
  if (!info || info.missingToken || !info.appinfo || !info.appinfo.depots) {
    throw new Error("PICS app metadata unavailable");
  }
  const depots = info.appinfo.depots;
  const ids = Object.entries(depots)
    .filter(([id, depot]) => {
      if (!/^\d+$/.test(id) || !depot || typeof depot !== "object") return false;
      const publicManifest = depot.manifests?.public;
      const hasPublicManifest = publicManifest && /^\d+$/.test(String(publicManifest.gid || ""));
      if (!hasPublicManifest && String(depot.sharedinstall || "") !== "1") return false;
      const oslist = String(depot.config?.oslist || "").toLowerCase().split(",").map((part) => part.trim());
      return !depot.config?.oslist || oslist.includes("windows");
    })
    .map(([id]) => id)
    .sort((a, b) => Number(a) - Number(b));
  if (ids.length === 0) throw new Error("PICS returned no applicable public depots");
  return ids;
}

async function getPublicDepotIds(appId) {
  await ensureLoggedOn();
  const { apps } = await steam.getProductInfo([Number(appId)], [], true);
  return applicablePublicDepots(apps?.[appId]);
}

module.exports = { getPublicDepotIds, applicablePublicDepots };
