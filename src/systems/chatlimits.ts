import { setting } from "./gamesettings/store";

/** The longest chat message, in characters; read when a message arrives. */
export const maxChatLength = (): number => setting("chatMaxLength");
/** The longest command line read: a command is a name and a few arguments, or a chat line sent through /party, /guild or /whisper. */
export const maxCommandLength = (): number => maxChatLength() + 100;
/** How many chat messages a player may send in one rate window, and how long that window is (ms); read when a message arrives. */
export const chatRateMax = (): number => setting("chatRateMax");
export const chatRateWindow = (): number => setting("chatRateWindowMs");

/** Whether a chat message is over the cap and is refused. */
export const chatTooLong = (message: string): boolean => message.length > maxChatLength();
