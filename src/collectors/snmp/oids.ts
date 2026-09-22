/** Standard MIB objects (RFC 3418 SNMPv2-MIB, RFC 2863 IF-MIB, RFC 2790 HOST-RESOURCES-MIB). */
export const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',

  // HOST-RESOURCES-MIB
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  hrStorageTable: '1.3.6.1.2.1.25.2.3',
  hrStorageRam: '1.3.6.1.2.1.25.2.1.2',

  // IF-MIB
  ifTable: '1.3.6.1.2.1.2.2',
  ifXTable: '1.3.6.1.2.1.31.1.1',
} as const;

/** Column numbers inside ifTable (1.3.6.1.2.1.2.2.1.<n>) */
export const IF_COL = {
  descr: 2,
  type: 3,
  speed: 5,
  adminStatus: 7,
  operStatus: 8,
  inOctets: 10,
  inDiscards: 13,
  inErrors: 14,
  outOctets: 16,
  outDiscards: 19,
  outErrors: 20,
} as const;

/** Column numbers inside ifXTable (1.3.6.1.2.1.31.1.1.1.<n>) */
export const IFX_COL = {
  name: 1,
  hcInOctets: 6,
  hcOutOctets: 10,
  highSpeed: 15,
  alias: 18,
} as const;

/** Column numbers inside hrStorageTable (1.3.6.1.2.1.25.2.3.1.<n>) */
export const HR_STORAGE_COL = {
  type: 2,
  descr: 3,
  allocationUnits: 4,
  size: 5,
  used: 6,
} as const;

export const IF_TYPE_NAME: Record<number, string> = {
  1: 'other',
  6: 'ethernetCsmacd',
  24: 'softwareLoopback',
  53: 'propVirtual',
  62: 'fastEther',
  71: 'ieee80211',
  117: 'gigabitEthernet',
  131: 'tunnel',
  135: 'l2vlan',
  136: 'l3ipvlan',
  161: 'ieee8023adLag',
  166: 'mpls',
  209: 'bridge',
};

export const OPER_STATUS: Record<number, string> = {
  1: 'up',
  2: 'down',
  3: 'testing',
  4: 'unknown',
  5: 'dormant',
  6: 'notPresent',
  7: 'lowerLayerDown',
};

export const ADMIN_STATUS: Record<number, string> = { 1: 'up', 2: 'down', 3: 'testing' };
