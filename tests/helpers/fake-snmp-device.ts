import dgram from 'node:dgram';
import * as snmp from 'net-snmp';

/**
 * A real SNMP agent (UDP, loopback) used to exercise the real collector code path end to end.
 * It is a test double for a *device*, not for the engine: everything the engine does against it is genuine SNMP.
 */
export interface FakeInterface {
  index: number;
  name: string;
  alias?: string;
  type?: number;
  speedMbps?: number;
  admin?: number;
  oper?: number;
  in32?: number;
  out32?: number;
  inHc?: bigint;
  outHc?: bigint;
  inErrors?: number;
  outErrors?: number;
  inDiscards?: number;
  outDiscards?: number;
}

export interface FakeDeviceOptions {
  community?: string;
  v3?: { name: string; authProtocol?: number; authKey?: string; privProtocol?: number; privKey?: string };
  sysName?: string;
  sysDescr?: string;
  sysObjectId?: string;
  uptimeTicks?: number;
  cpuLoads?: number[] | null; // null = hrProcessorTable not implemented
  memory?: { descr: string; type: string; size: number; used: number }[] | null; // null = hrStorageTable not implemented
  interfaces?: FakeInterface[];
  ifX?: boolean; // implement ifXTable (64-bit counters, ifName, ifAlias, ifHighSpeed)
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

const u64 = (v: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(v);
  return b;
};

export class FakeSnmpDevice {
  port = 0;
  private agent: any;
  private mib: any;

  constructor(private readonly o: FakeDeviceOptions = {}) {}

  /** Start the agent. Pass the previous port to restart the "same device" after stop(). */
  async start(port?: number): Promise<this> {
    this.port = port ?? (await freePort());
    this.agent = snmp.createAgent({ port: this.port, address: '127.0.0.1', disableAuthorization: false }, () => undefined);
    const auth = this.agent.getAuthorizer();
    auth.addCommunity(this.o.community ?? 'public');
    if (this.o.v3) {
      const v = this.o.v3;
      auth.addUser({
        name: v.name,
        level: v.privKey ? snmp.SecurityLevel.authPriv : v.authKey ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv,
        authProtocol: v.authProtocol,
        authKey: v.authKey,
        privProtocol: v.privProtocol,
        privKey: v.privKey,
      });
    }
    this.mib = this.agent.getMib();
    this.registerSystem();
    if (this.o.cpuLoads !== null) this.registerCpu(this.o.cpuLoads ?? [10, 20]);
    if (this.o.memory !== null) this.registerStorage(this.o.memory ?? [{ descr: 'main memory', type: '1.3.6.1.2.1.25.2.1.2', size: 1000, used: 250 }]);
    this.registerInterfaces(this.o.interfaces ?? []);
    return this;
  }

  private scalar(name: string, oid: string, type: number, value: unknown) {
    this.mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: snmp.MaxAccess['read-only'] });
    this.mib.setScalarValue(name, value);
  }

  private registerSystem() {
    this.scalar('sysDescr', '1.3.6.1.2.1.1.1', snmp.ObjectType.OctetString, this.o.sysDescr ?? 'Fake Router OS 1.0');
    this.scalar('sysObjectID', '1.3.6.1.2.1.1.2', snmp.ObjectType.OID, this.o.sysObjectId ?? '1.3.6.1.4.1.99999.1');
    this.scalar('sysUpTime', '1.3.6.1.2.1.1.3', snmp.ObjectType.TimeTicks, this.o.uptimeTicks ?? 123456);
    this.scalar('sysName', '1.3.6.1.2.1.1.5', snmp.ObjectType.OctetString, this.o.sysName ?? 'fake-router');
  }

  private table(name: string, oid: string, columns: Array<[number, string, number]>, indexColumn: string) {
    this.mib.registerProvider({
      name,
      type: snmp.MibProviderType.Table,
      oid,
      maxAccess: snmp.MaxAccess['not-accessible'],
      tableColumns: columns.map(([number, cname, type]) => ({ number, name: cname, type, maxAccess: snmp.MaxAccess['read-only'] })),
      tableIndex: [{ columnName: indexColumn }],
    });
  }

  private registerCpu(loads: number[]) {
    this.table('hrProcessorTable', '1.3.6.1.2.1.25.3.3.1', [[1, 'idx', snmp.ObjectType.Integer], [2, 'load', snmp.ObjectType.Integer]], 'idx');
    loads.forEach((l, i) => this.mib.addTableRow('hrProcessorTable', [i + 1, l]));
  }

  private registerStorage(entries: NonNullable<FakeDeviceOptions['memory']>) {
    this.table(
      'hrStorageTable',
      '1.3.6.1.2.1.25.2.3.1',
      [
        [1, 'idx', snmp.ObjectType.Integer],
        [2, 'type', snmp.ObjectType.OID],
        [3, 'descr', snmp.ObjectType.OctetString],
        [4, 'unit', snmp.ObjectType.Integer],
        [5, 'size', snmp.ObjectType.Integer],
        [6, 'used', snmp.ObjectType.Integer],
      ],
      'idx',
    );
    entries.forEach((e, i) => this.mib.addTableRow('hrStorageTable', [i + 1, e.type, e.descr, 1024, e.size, e.used]));
  }

  private registerInterfaces(ifs: FakeInterface[]) {
    if (ifs.length === 0) return;
    const C = snmp.ObjectType.Counter;
    this.table(
      'ifTable',
      '1.3.6.1.2.1.2.2.1',
      [
        [1, 'ifIndex', snmp.ObjectType.Integer],
        [2, 'ifDescr', snmp.ObjectType.OctetString],
        [3, 'ifType', snmp.ObjectType.Integer],
        [5, 'ifSpeed', snmp.ObjectType.Gauge],
        [7, 'ifAdminStatus', snmp.ObjectType.Integer],
        [8, 'ifOperStatus', snmp.ObjectType.Integer],
        [10, 'ifInOctets', C],
        [13, 'ifInDiscards', C],
        [14, 'ifInErrors', C],
        [16, 'ifOutOctets', C],
        [19, 'ifOutDiscards', C],
        [20, 'ifOutErrors', C],
      ],
      'ifIndex',
    );
    for (const i of ifs) this.mib.addTableRow('ifTable', this.ifRowValues(i));
    if (this.o.ifX === false) return;
    this.table(
      'ifXTable',
      '1.3.6.1.2.1.31.1.1.1',
      [
        [1, 'ifName', snmp.ObjectType.OctetString],
        [6, 'ifHCInOctets', snmp.ObjectType.Counter64],
        [10, 'ifHCOutOctets', snmp.ObjectType.Counter64],
        [15, 'ifHighSpeed', snmp.ObjectType.Gauge],
        [18, 'ifAlias', snmp.ObjectType.OctetString],
        [99, 'idx', snmp.ObjectType.Integer], // ifXTable is indexed by ifIndex; test agents need an explicit index column
      ],
      'idx',
    );
    for (const i of ifs) this.mib.addTableRow('ifXTable', this.ifxRowValues(i));
  }

  private ifRowValues(i: FakeInterface): unknown[] {
    return [
      i.index,
      `descr-${i.name}`,
      i.type ?? 6,
      i.speedMbps ? Math.min(i.speedMbps * 1_000_000, 4_294_967_295) : 0,
      i.admin ?? 1,
      i.oper ?? 1,
      i.in32 ?? 0,
      i.inDiscards ?? 0,
      i.inErrors ?? 0,
      i.out32 ?? 0,
      i.outDiscards ?? 0,
      i.outErrors ?? 0,
    ];
  }

  private ifxRowValues(i: FakeInterface): unknown[] {
    return [i.name, u64(i.inHc ?? 0n), u64(i.outHc ?? 0n), i.speedMbps ?? 0, i.alias ?? '', i.index];
  }

  /** ifOperStatus: 1 up, 2 down, 3 testing, 4 unknown, 5 dormant, 6 notPresent, 7 lowerLayerDown */
  setOperStatus(ifIndex: number, value: number) {
    this.mib.setTableSingleCell('ifTable', 8, [ifIndex], value);
  }

  /** ifAdminStatus: 1 up, 2 down, 3 testing */
  setAdminStatus(ifIndex: number, value: number) {
    this.mib.setTableSingleCell('ifTable', 7, [ifIndex], value);
  }

  /** The interface disappears from the SNMP walk (like a dynamic PPP/L2TP interface going away). */
  removeInterface(ifIndex: number) {
    this.mib.deleteTableRow('ifTable', [ifIndex]);
    if (this.o.ifX !== false) this.mib.deleteTableRow('ifXTable', [ifIndex]);
  }

  /** The interface appears in the SNMP walk (again). */
  addInterface(i: FakeInterface) {
    this.mib.addTableRow('ifTable', this.ifRowValues(i));
    if (this.o.ifX !== false) this.mib.addTableRow('ifXTable', this.ifxRowValues(i));
  }

  setCounters(ifIndex: number, c: { inHc?: bigint; outHc?: bigint; in32?: number; out32?: number }) {
    if (c.in32 !== undefined) this.mib.setTableSingleCell('ifTable', 10, [ifIndex], c.in32);
    if (c.out32 !== undefined) this.mib.setTableSingleCell('ifTable', 16, [ifIndex], c.out32);
    if (c.inHc !== undefined) this.mib.setTableSingleCell('ifXTable', 6, [ifIndex], u64(c.inHc));
    if (c.outHc !== undefined) this.mib.setTableSingleCell('ifXTable', 10, [ifIndex], u64(c.outHc));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.agent.close(() => resolve()));
  }
}

/** A UDP endpoint that answers every datagram with garbage: malformed SNMP response. */
export async function startGarbageResponder(): Promise<{ port: number; stop: () => Promise<void> }> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (_msg, rinfo) => socket.send(Buffer.from('this is definitely not BER encoded SNMP'), rinfo.port, rinfo.address));
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, stop: () => new Promise<void>((r) => socket.close(() => r())) };
}

/** A port on which nothing listens: requests time out. */
export const deadPort = freePort;
