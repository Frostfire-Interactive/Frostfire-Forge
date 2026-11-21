import effectManager from "../services/effectmanager";
import dots from "../systems/dots";
import { getStunsForPlayer, getSlowsForPlayer } from "../systems/spelleffects";
import { saveOnDisconnect as saveSicknessOnDisconnect } from "../systems/resurrection";
import player from "../systems/player";
import { leaveSaves } from "./leavesavecore";

export const { saveLeavingEffects, saveLeavingState } = leaveSaves({
  effectManager,
  dots,
  getStunsForPlayer,
  getSlowsForPlayer,
  saveSicknessOnDisconnect,
  player,
});
