// src/socket/handlers/context.ts

export interface PacketContext {
  server: any;
  wt: any;
  message: string;
  parsedMessage: Packet;
  data: any;
  type: string;
  currentPlayer: any;
  resolveNpcParticles: (npc: Npc) => Promise<Npc>;
  resolveNpcForClient: (npc: Npc) => Promise<any>;
}
