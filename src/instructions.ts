import {enumKeys} from "./utils";

export enum X86InstructionCode {
    AAA = 1,
    AAD = 2,
    AAM = 3,
    AAS = 4,
    FABS = 5,
    ADC = 6,
    ADCX = 7,
    ADD = 8,
    ADDPD = 9,
    ADDPS = 10,
    ADDSD = 11,
    ADDSS = 12,
    ADDSUBPD = 13,
    ADDSUBPS = 14,
    FADD = 15,
    FIADD = 16,
    FADDP = 17,
    ADOX = 18,
    AESDECLAST = 19,
    AESDEC = 20,
    AESENCLAST = 21,
    AESENC = 22,
    AESIMC = 23,
    AESKEYGENASSIST = 24,
    AND = 25,
    ANDN = 26,
    ANDNPD = 27,
    ANDNPS = 28,
    ANDPD = 29,
    ANDPS = 30,
    ARPL = 31,
    BEXTR = 32,
    BLCFILL = 33,
    BLCI = 34,
    BLCIC = 35,
    BLCMSK = 36,
    BLCS = 37,
    BLENDPD = 38,
    BLENDPS = 39,
    BLENDVPD = 40,
    BLENDVPS = 41,
    BLSFILL = 42,
    BLSI = 43,
    BLSIC = 44,
    BLSMSK = 45,
    BLSR = 46,
    BOUND = 47,
    BSF = 48,
    BSR = 49,
    BSWAP = 50,
    BT = 51,
    BTC = 52,
    BTR = 53,
    BTS = 54,
    BZHI = 55,
    CALL = 56,
    CBW = 57,
    CDQ = 58,
    CDQE = 59,
    FCHS = 60,
    CLAC = 61,
    CLC = 62,
    CLD = 63,
    CLFLUSH = 64,
    CLFLUSHOPT = 65,
    CLGI = 66,
    CLI = 67,
    CLTS = 68,
    CLWB = 69,
    CMC = 70,
    CMOVA = 71,
    CMOVAE = 72,
    CMOVB = 73,
    CMOVBE = 74,
    FCMOVBE = 75,
    FCMOVB = 76,
    CMOVE = 77,
    FCMOVE = 78,
    CMOVG = 79,
    CMOVGE = 80,
    CMOVL = 81,
    CMOVLE = 82,
    FCMOVNBE = 83,
    FCMOVNB = 84,
    CMOVNE = 85,
    FCMOVNE = 86,
    CMOVNO = 87,
    CMOVNP = 88,
    FCMOVNU = 89,
    CMOVNS = 90,
    CMOVO = 91,
    CMOVP = 92,
    FCMOVU = 93,
    CMOVS = 94,
    CMP = 95,
    CMPPD = 96,
    CMPPS = 97,
    CMPSB = 98,
    CMPSD = 99,
    CMPSQ = 100,
    CMPSS = 101,
    CMPSW = 102,
    CMPXCHG16B = 103,
    CMPXCHG = 104,
    CMPXCHG8B = 105,
    COMISD = 106,
    COMISS = 107,
    FCOMP = 108,
    FCOMPI = 109,
    FCOMI = 110,
    FCOM = 111,
    FCOS = 112,
    CPUID = 113,
    CQO = 114,
    CRC32 = 115,
    CVTDQ2PD = 116,
    CVTDQ2PS = 117,
    CVTPD2DQ = 118,
    CVTPD2PS = 119,
    CVTPS2DQ = 120,
    CVTPS2PD = 121,
    CVTSD2SI = 122,
    CVTSD2SS = 123,
    CVTSI2SD = 124,
    CVTSI2SS = 125,
    CVTSS2SD = 126,
    CVTSS2SI = 127,
    CVTTPD2DQ = 128,
    CVTTPS2DQ = 129,
    CVTTSD2SI = 130,
    CVTTSS2SI = 131,
    CWD = 132,
    CWDE = 133,
    DAA = 134,
    DAS = 135,
    DATA16 = 136,
    DEC = 137,
    DIV = 138,
    DIVPD = 139,
    DIVPS = 140,
    FDIVR = 141,
    FIDIVR = 142,
    FDIVRP = 143,
    DIVSD = 144,
    DIVSS = 145,
    FDIV = 146,
    FIDIV = 147,
    FDIVP = 148,
    DPPD = 149,
    DPPS = 150,
    RET = 151,
    ENCLS = 152,
    ENCLU = 153,
    ENTER = 154,
    EXTRACTPS = 155,
    EXTRQ = 156,
    F2XM1 = 157,
    LCALL = 158,
    LJMP = 159,
    FBLD = 160,
    FBSTP = 161,
    FCOMPP = 162,
    FDECSTP = 163,
    FEMMS = 164,
    FFREE = 165,
    FICOM = 166,
    FICOMP = 167,
    FINCSTP = 168,
    FLDCW = 169,
    FLDENV = 170,
    FLDL2E = 171,
    FLDL2T = 172,
    FLDLG2 = 173,
    FLDLN2 = 174,
    FLDPI = 175,
    FNCLEX = 176,
    FNINIT = 177,
    FNOP = 178,
    FNSTCW = 179,
    FNSTSW = 180,
    FPATAN = 181,
    FPREM = 182,
    FPREM1 = 183,
    FPTAN = 184,
    FFREEP = 185,
    FRNDINT = 186,
    FRSTOR = 187,
    FNSAVE = 188,
    FSCALE = 189,
    FSETPM = 190,
    FSINCOS = 191,
    FNSTENV = 192,
    FXAM = 193,
    FXRSTOR = 194,
    FXRSTOR64 = 195,
    FXSAVE = 196,
    FXSAVE64 = 197,
    FXTRACT = 198,
    FYL2X = 199,
    FYL2XP1 = 200,
    MOVAPD = 201,
    MOVAPS = 202,
    ORPD = 203,
    ORPS = 204,
    VMOVAPD = 205,
    VMOVAPS = 206,
    XORPD = 207,
    XORPS = 208,
    GETSEC = 209,
    HADDPD = 210,
    HADDPS = 211,
    HLT = 212,
    HSUBPD = 213,
    HSUBPS = 214,
    IDIV = 215,
    FILD = 216,
    IMUL = 217,
    IN = 218,
    INC = 219,
    INSB = 220,
    INSERTPS = 221,
    INSERTQ = 222,
    INSD = 223,
    INSW = 224,
    INT = 225,
    INT1 = 226,
    INT3 = 227,
    INTO = 228,
    INVD = 229,
    INVEPT = 230,
    INVLPG = 231,
    INVLPGA = 232,
    INVPCID = 233,
    INVVPID = 234,
    IRET = 235,
    IRETD = 236,
    IRETQ = 237,
    FISTTP = 238,
    FIST = 239,
    FISTP = 240,
    UCOMISD = 241,
    UCOMISS = 242,
    VCOMISD = 243,
    VCOMISS = 244,
    VCVTSD2SS = 245,
    VCVTSI2SD = 246,
    VCVTSI2SS = 247,
    VCVTSS2SD = 248,
    VCVTTSD2SI = 249,
    VCVTTSD2USI = 250,
    VCVTTSS2SI = 251,
    VCVTTSS2USI = 252,
    VCVTUSI2SD = 253,
    VCVTUSI2SS = 254,
    VUCOMISD = 255,
    VUCOMISS = 256,
    JAE = 257,
    JA = 258,
    JBE = 259,
    JB = 260,
    JCXZ = 261,
    JECXZ = 262,
    JE = 263,
    JGE = 264,
    JG = 265,
    JLE = 266,
    JL = 267,
    JMP = 268,
    JNE = 269,
    JNO = 270,
    JNP = 271,
    JNS = 272,
    JO = 273,
    JP = 274,
    JRCXZ = 275,
    JS = 276,
    KANDB = 277,
    KANDD = 278,
    KANDNB = 279,
    KANDND = 280,
    KANDNQ = 281,
    KANDNW = 282,
    KANDQ = 283,
    KANDW = 284,
    KMOVB = 285,
    KMOVD = 286,
    KMOVQ = 287,
    KMOVW = 288,
    KNOTB = 289,
    KNOTD = 290,
    KNOTQ = 291,
    KNOTW = 292,
    KORB = 293,
    KORD = 294,
    KORQ = 295,
    KORTESTB = 296,
    KORTESTD = 297,
    KORTESTQ = 298,
    KORTESTW = 299,
    KORW = 300,
    KSHIFTLB = 301,
    KSHIFTLD = 302,
    KSHIFTLQ = 303,
    KSHIFTLW = 304,
    KSHIFTRB = 305,
    KSHIFTRD = 306,
    KSHIFTRQ = 307,
    KSHIFTRW = 308,
    KUNPCKBW = 309,
    KXNORB = 310,
    KXNORD = 311,
    KXNORQ = 312,
    KXNORW = 313,
    KXORB = 314,
    KXORD = 315,
    KXORQ = 316,
    KXORW = 317,
    LAHF = 318,
    LAR = 319,
    LDDQU = 320,
    LDMXCSR = 321,
    LDS = 322,
    FLDZ = 323,
    FLD1 = 324,
    FLD = 325,
    LEA = 326,
    LEAVE = 327,
    LES = 328,
    LFENCE = 329,
    LFS = 330,
    LGDT = 331,
    LGS = 332,
    LIDT = 333,
    LLDT = 334,
    LMSW = 335,
    OR = 336,
    SUB = 337,
    XOR = 338,
    LODSB = 339,
    LODSD = 340,
    LODSQ = 341,
    LODSW = 342,
    LOOP = 343,
    LOOPE = 344,
    LOOPNE = 345,
    RETF = 346,
    RETFQ = 347,
    LSL = 348,
    LSS = 349,
    LTR = 350,
    XADD = 351,
    LZCNT = 352,
    MASKMOVDQU = 353,
    MAXPD = 354,
    MAXPS = 355,
    MAXSD = 356,
    MAXSS = 357,
    MFENCE = 358,
    MINPD = 359,
    MINPS = 360,
    MINSD = 361,
    MINSS = 362,
    CVTPD2PI = 363,
    CVTPI2PD = 364,
    CVTPI2PS = 365,
    CVTPS2PI = 366,
    CVTTPD2PI = 367,
    CVTTPS2PI = 368,
    EMMS = 369,
    MASKMOVQ = 370,
    MOVD = 371,
    MOVDQ2Q = 372,
    MOVNTQ = 373,
    MOVQ2DQ = 374,
    MOVQ = 375,
    PABSB = 376,
    PABSD = 377,
    PABSW = 378,
    PACKSSDW = 379,
    PACKSSWB = 380,
    PACKUSWB = 381,
    PADDB = 382,
    PADDD = 383,
    PADDQ = 384,
    PADDSB = 385,
    PADDSW = 386,
    PADDUSB = 387,
    PADDUSW = 388,
    PADDW = 389,
    PALIGNR = 390,
    PANDN = 391,
    PAND = 392,
    PAVGB = 393,
    PAVGW = 394,
    PCMPEQB = 395,
    PCMPEQD = 396,
    PCMPEQW = 397,
    PCMPGTB = 398,
    PCMPGTD = 399,
    PCMPGTW = 400,
    PEXTRW = 401,
    PHADDSW = 402,
    PHADDW = 403,
    PHADDD = 404,
    PHSUBD = 405,
    PHSUBSW = 406,
    PHSUBW = 407,
    PINSRW = 408,
    PMADDUBSW = 409,
    PMADDWD = 410,
    PMAXSW = 411,
    PMAXUB = 412,
    PMINSW = 413,
    PMINUB = 414,
    PMOVMSKB = 415,
    PMULHRSW = 416,
    PMULHUW = 417,
    PMULHW = 418,
    PMULLW = 419,
    PMULUDQ = 420,
    POR = 421,
    PSADBW = 422,
    PSHUFB = 423,
    PSHUFW = 424,
    PSIGNB = 425,
    PSIGND = 426,
    PSIGNW = 427,
    PSLLD = 428,
    PSLLQ = 429,
    PSLLW = 430,
    PSRAD = 431,
    PSRAW = 432,
    PSRLD = 433,
    PSRLQ = 434,
    PSRLW = 435,
    PSUBB = 436,
    PSUBD = 437,
    PSUBQ = 438,
    PSUBSB = 439,
    PSUBSW = 440,
    PSUBUSB = 441,
    PSUBUSW = 442,
    PSUBW = 443,
    PUNPCKHBW = 444,
    PUNPCKHDQ = 445,
    PUNPCKHWD = 446,
    PUNPCKLBW = 447,
    PUNPCKLDQ = 448,
    PUNPCKLWD = 449,
    PXOR = 450,
    MONITOR = 451,
    MONTMUL = 452,
    MOV = 453,
    MOVABS = 454,
    MOVBE = 455,
    MOVDDUP = 456,
    MOVDQA = 457,
    MOVDQU = 458,
    MOVHLPS = 459,
    MOVHPD = 460,
    MOVHPS = 461,
    MOVLHPS = 462,
    MOVLPD = 463,
    MOVLPS = 464,
    MOVMSKPD = 465,
    MOVMSKPS = 466,
    MOVNTDQA = 467,
    MOVNTDQ = 468,
    MOVNTI = 469,
    MOVNTPD = 470,
    MOVNTPS = 471,
    MOVNTSD = 472,
    MOVNTSS = 473,
    MOVSB = 474,
    MOVSD = 475,
    MOVSHDUP = 476,
    MOVSLDUP = 477,
    MOVSQ = 478,
    MOVSS = 479,
    MOVSW = 480,
    MOVSX = 481,
    MOVSXD = 482,
    MOVUPD = 483,
    MOVUPS = 484,
    MOVZX = 485,
    MPSADBW = 486,
    MUL = 487,
    MULPD = 488,
    MULPS = 489,
    MULSD = 490,
    MULSS = 491,
    MULX = 492,
    FMUL = 493,
    FIMUL = 494,
    FMULP = 495,
    MWAIT = 496,
    NEG = 497,
    NOP = 498,
    NOT = 499,
    OUT = 500,
    OUTSB = 501,
    OUTSD = 502,
    OUTSW = 503,
    PACKUSDW = 504,
    PAUSE = 505,
    PAVGUSB = 506,
    PBLENDVB = 507,
    PBLENDW = 508,
    PCLMULQDQ = 509,
    PCMPEQQ = 510,
    PCMPESTRI = 511,
    PCMPESTRM = 512,
    PCMPGTQ = 513,
    PCMPISTRI = 514,
    PCMPISTRM = 515,
    PCOMMIT = 516,
    PDEP = 517,
    PEXT = 518,
    PEXTRB = 519,
    PEXTRD = 520,
    PEXTRQ = 521,
    PF2ID = 522,
    PF2IW = 523,
    PFACC = 524,
    PFADD = 525,
    PFCMPEQ = 526,
    PFCMPGE = 527,
    PFCMPGT = 528,
    PFMAX = 529,
    PFMIN = 530,
    PFMUL = 531,
    PFNACC = 532,
    PFPNACC = 533,
    PFRCPIT1 = 534,
    PFRCPIT2 = 535,
    PFRCP = 536,
    PFRSQIT1 = 537,
    PFRSQRT = 538,
    PFSUBR = 539,
    PFSUB = 540,
    PHMINPOSUW = 541,
    PI2FD = 542,
    PI2FW = 543,
    PINSRB = 544,
    PINSRD = 545,
    PINSRQ = 546,
    PMAXSB = 547,
    PMAXSD = 548,
    PMAXUD = 549,
    PMAXUW = 550,
    PMINSB = 551,
    PMINSD = 552,
    PMINUD = 553,
    PMINUW = 554,
    PMOVSXBD = 555,
    PMOVSXBQ = 556,
    PMOVSXBW = 557,
    PMOVSXDQ = 558,
    PMOVSXWD = 559,
    PMOVSXWQ = 560,
    PMOVZXBD = 561,
    PMOVZXBQ = 562,
    PMOVZXBW = 563,
    PMOVZXDQ = 564,
    PMOVZXWD = 565,
    PMOVZXWQ = 566,
    PMULDQ = 567,
    PMULHRW = 568,
    PMULLD = 569,
    POP = 570,
    POPAW = 571,
    POPAL = 572,
    POPCNT = 573,
    POPF = 574,
    POPFD = 575,
    POPFQ = 576,
    PREFETCH = 577,
    PREFETCHNTA = 578,
    PREFETCHT0 = 579,
    PREFETCHT1 = 580,
    PREFETCHT2 = 581,
    PREFETCHW = 582,
    PSHUFD = 583,
    PSHUFHW = 584,
    PSHUFLW = 585,
    PSLLDQ = 586,
    PSRLDQ = 587,
    PSWAPD = 588,
    PTEST = 589,
    PUNPCKHQDQ = 590,
    PUNPCKLQDQ = 591,
    PUSH = 592,
    PUSHAW = 593,
    PUSHAL = 594,
    PUSHF = 595,
    PUSHFD = 596,
    PUSHFQ = 597,
    RCL = 598,
    RCPPS = 599,
    RCPSS = 600,
    RCR = 601,
    RDFSBASE = 602,
    RDGSBASE = 603,
    RDMSR = 604,
    RDPMC = 605,
    RDRAND = 606,
    RDSEED = 607,
    RDTSC = 608,
    RDTSCP = 609,
    ROL = 610,
    ROR = 611,
    RORX = 612,
    ROUNDPD = 613,
    ROUNDPS = 614,
    ROUNDSD = 615,
    ROUNDSS = 616,
    RSM = 617,
    RSQRTPS = 618,
    RSQRTSS = 619,
    SAHF = 620,
    SAL = 621,
    SALC = 622,
    SAR = 623,
    SARX = 624,
    SBB = 625,
    SCASB = 626,
    SCASD = 627,
    SCASQ = 628,
    SCASW = 629,
    SETAE = 630,
    SETA = 631,
    SETBE = 632,
    SETB = 633,
    SETE = 634,
    SETGE = 635,
    SETG = 636,
    SETLE = 637,
    SETL = 638,
    SETNE = 639,
    SETNO = 640,
    SETNP = 641,
    SETNS = 642,
    SETO = 643,
    SETP = 644,
    SETS = 645,
    SFENCE = 646,
    SGDT = 647,
    SHA1MSG1 = 648,
    SHA1MSG2 = 649,
    SHA1NEXTE = 650,
    SHA1RNDS4 = 651,
    SHA256MSG1 = 652,
    SHA256MSG2 = 653,
    SHA256RNDS2 = 654,
    SHL = 655,
    SHLD = 656,
    SHLX = 657,
    SHR = 658,
    SHRD = 659,
    SHRX = 660,
    SHUFPD = 661,
    SHUFPS = 662,
    SIDT = 663,
    FSIN = 664,
    SKINIT = 665,
    SLDT = 666,
    SMSW = 667,
    SQRTPD = 668,
    SQRTPS = 669,
    SQRTSD = 670,
    SQRTSS = 671,
    FSQRT = 672,
    STAC = 673,
    STC = 674,
    STD = 675,
    STGI = 676,
    STI = 677,
    STMXCSR = 678,
    STOSB = 679,
    STOSD = 680,
    STOSQ = 681,
    STOSW = 682,
    STR = 683,
    FST = 684,
    FSTP = 685,
    FSTPNCE = 686,
    FXCH = 687,
    SUBPD = 688,
    SUBPS = 689,
    FSUBR = 690,
    FISUBR = 691,
    FSUBRP = 692,
    SUBSD = 693,
    SUBSS = 694,
    FSUB = 695,
    FISUB = 696,
    FSUBP = 697,
    SWAPGS = 698,
    SYSCALL = 699,
    SYSENTER = 700,
    SYSEXIT = 701,
    SYSRET = 702,
    T1MSKC = 703,
    TEST = 704,
    UD2 = 705,
    FTST = 706,
    TZCNT = 707,
    TZMSK = 708,
    FUCOMPI = 709,
    FUCOMI = 710,
    FUCOMPP = 711,
    FUCOMP = 712,
    FUCOM = 713,
    UD2B = 714,
    UNPCKHPD = 715,
    UNPCKHPS = 716,
    UNPCKLPD = 717,
    UNPCKLPS = 718,
    VADDPD = 719,
    VADDPS = 720,
    VADDSD = 721,
    VADDSS = 722,
    VADDSUBPD = 723,
    VADDSUBPS = 724,
    VAESDECLAST = 725,
    VAESDEC = 726,
    VAESENCLAST = 727,
    VAESENC = 728,
    VAESIMC = 729,
    VAESKEYGENASSIST = 730,
    VALIGND = 731,
    VALIGNQ = 732,
    VANDNPD = 733,
    VANDNPS = 734,
    VANDPD = 735,
    VANDPS = 736,
    VBLENDMPD = 737,
    VBLENDMPS = 738,
    VBLENDPD = 739,
    VBLENDPS = 740,
    VBLENDVPD = 741,
    VBLENDVPS = 742,
    VBROADCASTF128 = 743,
    VBROADCASTI32X4 = 744,
    VBROADCASTI64X4 = 745,
    VBROADCASTSD = 746,
    VBROADCASTSS = 747,
    VCMPPD = 748,
    VCMPPS = 749,
    VCMPSD = 750,
    VCMPSS = 751,
    VCOMPRESSPD = 752,
    VCOMPRESSPS = 753,
    VCVTDQ2PD = 754,
    VCVTDQ2PS = 755,
    VCVTPD2DQX = 756,
    VCVTPD2DQ = 757,
    VCVTPD2PSX = 758,
    VCVTPD2PS = 759,
    VCVTPD2UDQ = 760,
    VCVTPH2PS = 761,
    VCVTPS2DQ = 762,
    VCVTPS2PD = 763,
    VCVTPS2PH = 764,
    VCVTPS2UDQ = 765,
    VCVTSD2SI = 766,
    VCVTSD2USI = 767,
    VCVTSS2SI = 768,
    VCVTSS2USI = 769,
    VCVTTPD2DQX = 770,
    VCVTTPD2DQ = 771,
    VCVTTPD2UDQ = 772,
    VCVTTPS2DQ = 773,
    VCVTTPS2UDQ = 774,
    VCVTUDQ2PD = 775,
    VCVTUDQ2PS = 776,
    VDIVPD = 777,
    VDIVPS = 778,
    VDIVSD = 779,
    VDIVSS = 780,
    VDPPD = 781,
    VDPPS = 782,
    VERR = 783,
    VERW = 784,
    VEXP2PD = 785,
    VEXP2PS = 786,
    VEXPANDPD = 787,
    VEXPANDPS = 788,
    VEXTRACTF128 = 789,
    VEXTRACTF32X4 = 790,
    VEXTRACTF64X4 = 791,
    VEXTRACTI128 = 792,
    VEXTRACTI32X4 = 793,
    VEXTRACTI64X4 = 794,
    VEXTRACTPS = 795,
    VFMADD132PD = 796,
    VFMADD132PS = 797,
    VFMADDPD = 798,
    VFMADD213PD = 799,
    VFMADD231PD = 800,
    VFMADDPS = 801,
    VFMADD213PS = 802,
    VFMADD231PS = 803,
    VFMADDSD = 804,
    VFMADD213SD = 805,
    VFMADD132SD = 806,
    VFMADD231SD = 807,
    VFMADDSS = 808,
    VFMADD213SS = 809,
    VFMADD132SS = 810,
    VFMADD231SS = 811,
    VFMADDSUB132PD = 812,
    VFMADDSUB132PS = 813,
    VFMADDSUBPD = 814,
    VFMADDSUB213PD = 815,
    VFMADDSUB231PD = 816,
    VFMADDSUBPS = 817,
    VFMADDSUB213PS = 818,
    VFMADDSUB231PS = 819,
    VFMSUB132PD = 820,
    VFMSUB132PS = 821,
    VFMSUBADD132PD = 822,
    VFMSUBADD132PS = 823,
    VFMSUBADDPD = 824,
    VFMSUBADD213PD = 825,
    VFMSUBADD231PD = 826,
    VFMSUBADDPS = 827,
    VFMSUBADD213PS = 828,
    VFMSUBADD231PS = 829,
    VFMSUBPD = 830,
    VFMSUB213PD = 831,
    VFMSUB231PD = 832,
    VFMSUBPS = 833,
    VFMSUB213PS = 834,
    VFMSUB231PS = 835,
    VFMSUBSD = 836,
    VFMSUB213SD = 837,
    VFMSUB132SD = 838,
    VFMSUB231SD = 839,
    VFMSUBSS = 840,
    VFMSUB213SS = 841,
    VFMSUB132SS = 842,
    VFMSUB231SS = 843,
    VFNMADD132PD = 844,
    VFNMADD132PS = 845,
    VFNMADDPD = 846,
    VFNMADD213PD = 847,
    VFNMADD231PD = 848,
    VFNMADDPS = 849,
    VFNMADD213PS = 850,
    VFNMADD231PS = 851,
    VFNMADDSD = 852,
    VFNMADD213SD = 853,
    VFNMADD132SD = 854,
    VFNMADD231SD = 855,
    VFNMADDSS = 856,
    VFNMADD213SS = 857,
    VFNMADD132SS = 858,
    VFNMADD231SS = 859,
    VFNMSUB132PD = 860,
    VFNMSUB132PS = 861,
    VFNMSUBPD = 862,
    VFNMSUB213PD = 863,
    VFNMSUB231PD = 864,
    VFNMSUBPS = 865,
    VFNMSUB213PS = 866,
    VFNMSUB231PS = 867,
    VFNMSUBSD = 868,
    VFNMSUB213SD = 869,
    VFNMSUB132SD = 870,
    VFNMSUB231SD = 871,
    VFNMSUBSS = 872,
    VFNMSUB213SS = 873,
    VFNMSUB132SS = 874,
    VFNMSUB231SS = 875,
    VFRCZPD = 876,
    VFRCZPS = 877,
    VFRCZSD = 878,
    VFRCZSS = 879,
    VORPD = 880,
    VORPS = 881,
    VXORPD = 882,
    VXORPS = 883,
    VGATHERDPD = 884,
    VGATHERDPS = 885,
    VGATHERPF0DPD = 886,
    VGATHERPF0DPS = 887,
    VGATHERPF0QPD = 888,
    VGATHERPF0QPS = 889,
    VGATHERPF1DPD = 890,
    VGATHERPF1DPS = 891,
    VGATHERPF1QPD = 892,
    VGATHERPF1QPS = 893,
    VGATHERQPD = 894,
    VGATHERQPS = 895,
    VHADDPD = 896,
    VHADDPS = 897,
    VHSUBPD = 898,
    VHSUBPS = 899,
    VINSERTF128 = 900,
    VINSERTF32X4 = 901,
    VINSERTF32X8 = 902,
    VINSERTF64X2 = 903,
    VINSERTF64X4 = 904,
    VINSERTI128 = 905,
    VINSERTI32X4 = 906,
    VINSERTI32X8 = 907,
    VINSERTI64X2 = 908,
    VINSERTI64X4 = 909,
    VINSERTPS = 910,
    VLDDQU = 911,
    VLDMXCSR = 912,
    VMASKMOVDQU = 913,
    VMASKMOVPD = 914,
    VMASKMOVPS = 915,
    VMAXPD = 916,
    VMAXPS = 917,
    VMAXSD = 918,
    VMAXSS = 919,
    VMCALL = 920,
    VMCLEAR = 921,
    VMFUNC = 922,
    VMINPD = 923,
    VMINPS = 924,
    VMINSD = 925,
    VMINSS = 926,
    VMLAUNCH = 927,
    VMLOAD = 928,
    VMMCALL = 929,
    VMOVQ = 930,
    VMOVDDUP = 931,
    VMOVD = 932,
    VMOVDQA32 = 933,
    VMOVDQA64 = 934,
    VMOVDQA = 935,
    VMOVDQU16 = 936,
    VMOVDQU32 = 937,
    VMOVDQU64 = 938,
    VMOVDQU8 = 939,
    VMOVDQU = 940,
    VMOVHLPS = 941,
    VMOVHPD = 942,
    VMOVHPS = 943,
    VMOVLHPS = 944,
    VMOVLPD = 945,
    VMOVLPS = 946,
    VMOVMSKPD = 947,
    VMOVMSKPS = 948,
    VMOVNTDQA = 949,
    VMOVNTDQ = 950,
    VMOVNTPD = 951,
    VMOVNTPS = 952,
    VMOVSD = 953,
    VMOVSHDUP = 954,
    VMOVSLDUP = 955,
    VMOVSS = 956,
    VMOVUPD = 957,
    VMOVUPS = 958,
    VMPSADBW = 959,
    VMPTRLD = 960,
    VMPTRST = 961,
    VMREAD = 962,
    VMRESUME = 963,
    VMRUN = 964,
    VMSAVE = 965,
    VMULPD = 966,
    VMULPS = 967,
    VMULSD = 968,
    VMULSS = 969,
    VMWRITE = 970,
    VMXOFF = 971,
    VMXON = 972,
    VPABSB = 973,
    VPABSD = 974,
    VPABSQ = 975,
    VPABSW = 976,
    VPACKSSDW = 977,
    VPACKSSWB = 978,
    VPACKUSDW = 979,
    VPACKUSWB = 980,
    VPADDB = 981,
    VPADDD = 982,
    VPADDQ = 983,
    VPADDSB = 984,
    VPADDSW = 985,
    VPADDUSB = 986,
    VPADDUSW = 987,
    VPADDW = 988,
    VPALIGNR = 989,
    VPANDD = 990,
    VPANDND = 991,
    VPANDNQ = 992,
    VPANDN = 993,
    VPANDQ = 994,
    VPAND = 995,
    VPAVGB = 996,
    VPAVGW = 997,
    VPBLENDD = 998,
    VPBLENDMB = 999,
    VPBLENDMD = 1000,
    VPBLENDMQ = 1001,
    VPBLENDMW = 1002,
    VPBLENDVB = 1003,
    VPBLENDW = 1004,
    VPBROADCASTB = 1005,
    VPBROADCASTD = 1006,
    VPBROADCASTMB2Q = 1007,
    VPBROADCASTMW2D = 1008,
    VPBROADCASTQ = 1009,
    VPBROADCASTW = 1010,
    VPCLMULQDQ = 1011,
    VPCMOV = 1012,
    VPCMPB = 1013,
    VPCMPD = 1014,
    VPCMPEQB = 1015,
    VPCMPEQD = 1016,
    VPCMPEQQ = 1017,
    VPCMPEQW = 1018,
    VPCMPESTRI = 1019,
    VPCMPESTRM = 1020,
    VPCMPGTB = 1021,
    VPCMPGTD = 1022,
    VPCMPGTQ = 1023,
    VPCMPGTW = 1024,
    VPCMPISTRI = 1025,
    VPCMPISTRM = 1026,
    VPCMPQ = 1027,
    VPCMPUB = 1028,
    VPCMPUD = 1029,
    VPCMPUQ = 1030,
    VPCMPUW = 1031,
    VPCMPW = 1032,
    VPCOMB = 1033,
    VPCOMD = 1034,
    VPCOMPRESSD = 1035,
    VPCOMPRESSQ = 1036,
    VPCOMQ = 1037,
    VPCOMUB = 1038,
    VPCOMUD = 1039,
    VPCOMUQ = 1040,
    VPCOMUW = 1041,
    VPCOMW = 1042,
    VPCONFLICTD = 1043,
    VPCONFLICTQ = 1044,
    VPERM2F128 = 1045,
    VPERM2I128 = 1046,
    VPERMD = 1047,
    VPERMI2D = 1048,
    VPERMI2PD = 1049,
    VPERMI2PS = 1050,
    VPERMI2Q = 1051,
    VPERMIL2PD = 1052,
    VPERMIL2PS = 1053,
    VPERMILPD = 1054,
    VPERMILPS = 1055,
    VPERMPD = 1056,
    VPERMPS = 1057,
    VPERMQ = 1058,
    VPERMT2D = 1059,
    VPERMT2PD = 1060,
    VPERMT2PS = 1061,
    VPERMT2Q = 1062,
    VPEXPANDD = 1063,
    VPEXPANDQ = 1064,
    VPEXTRB = 1065,
    VPEXTRD = 1066,
    VPEXTRQ = 1067,
    VPEXTRW = 1068,
    VPGATHERDD = 1069,
    VPGATHERDQ = 1070,
    VPGATHERQD = 1071,
    VPGATHERQQ = 1072,
    VPHADDBD = 1073,
    VPHADDBQ = 1074,
    VPHADDBW = 1075,
    VPHADDDQ = 1076,
    VPHADDD = 1077,
    VPHADDSW = 1078,
    VPHADDUBD = 1079,
    VPHADDUBQ = 1080,
    VPHADDUBW = 1081,
    VPHADDUDQ = 1082,
    VPHADDUWD = 1083,
    VPHADDUWQ = 1084,
    VPHADDWD = 1085,
    VPHADDWQ = 1086,
    VPHADDW = 1087,
    VPHMINPOSUW = 1088,
    VPHSUBBW = 1089,
    VPHSUBDQ = 1090,
    VPHSUBD = 1091,
    VPHSUBSW = 1092,
    VPHSUBWD = 1093,
    VPHSUBW = 1094,
    VPINSRB = 1095,
    VPINSRD = 1096,
    VPINSRQ = 1097,
    VPINSRW = 1098,
    VPLZCNTD = 1099,
    VPLZCNTQ = 1100,
    VPMACSDD = 1101,
    VPMACSDQH = 1102,
    VPMACSDQL = 1103,
    VPMACSSDD = 1104,
    VPMACSSDQH = 1105,
    VPMACSSDQL = 1106,
    VPMACSSWD = 1107,
    VPMACSSWW = 1108,
    VPMACSWD = 1109,
    VPMACSWW = 1110,
    VPMADCSSWD = 1111,
    VPMADCSWD = 1112,
    VPMADDUBSW = 1113,
    VPMADDWD = 1114,
    VPMASKMOVD = 1115,
    VPMASKMOVQ = 1116,
    VPMAXSB = 1117,
    VPMAXSD = 1118,
    VPMAXSQ = 1119,
    VPMAXSW = 1120,
    VPMAXUB = 1121,
    VPMAXUD = 1122,
    VPMAXUQ = 1123,
    VPMAXUW = 1124,
    VPMINSB = 1125,
    VPMINSD = 1126,
    VPMINSQ = 1127,
    VPMINSW = 1128,
    VPMINUB = 1129,
    VPMINUD = 1130,
    VPMINUQ = 1131,
    VPMINUW = 1132,
    VPMOVDB = 1133,
    VPMOVDW = 1134,
    VPMOVM2B = 1135,
    VPMOVM2D = 1136,
    VPMOVM2Q = 1137,
    VPMOVM2W = 1138,
    VPMOVMSKB = 1139,
    VPMOVQB = 1140,
    VPMOVQD = 1141,
    VPMOVQW = 1142,
    VPMOVSDB = 1143,
    VPMOVSDW = 1144,
    VPMOVSQB = 1145,
    VPMOVSQD = 1146,
    VPMOVSQW = 1147,
    VPMOVSXBD = 1148,
    VPMOVSXBQ = 1149,
    VPMOVSXBW = 1150,
    VPMOVSXDQ = 1151,
    VPMOVSXWD = 1152,
    VPMOVSXWQ = 1153,
    VPMOVUSDB = 1154,
    VPMOVUSDW = 1155,
    VPMOVUSQB = 1156,
    VPMOVUSQD = 1157,
    VPMOVUSQW = 1158,
    VPMOVZXBD = 1159,
    VPMOVZXBQ = 1160,
    VPMOVZXBW = 1161,
    VPMOVZXDQ = 1162,
    VPMOVZXWD = 1163,
    VPMOVZXWQ = 1164,
    VPMULDQ = 1165,
    VPMULHRSW = 1166,
    VPMULHUW = 1167,
    VPMULHW = 1168,
    VPMULLD = 1169,
    VPMULLQ = 1170,
    VPMULLW = 1171,
    VPMULUDQ = 1172,
    VPORD = 1173,
    VPORQ = 1174,
    VPOR = 1175,
    VPPERM = 1176,
    VPROTB = 1177,
    VPROTD = 1178,
    VPROTQ = 1179,
    VPROTW = 1180,
    VPSADBW = 1181,
    VPSCATTERDD = 1182,
    VPSCATTERDQ = 1183,
    VPSCATTERQD = 1184,
    VPSCATTERQQ = 1185,
    VPSHAB = 1186,
    VPSHAD = 1187,
    VPSHAQ = 1188,
    VPSHAW = 1189,
    VPSHLB = 1190,
    VPSHLD = 1191,
    VPSHLQ = 1192,
    VPSHLW = 1193,
    VPSHUFB = 1194,
    VPSHUFD = 1195,
    VPSHUFHW = 1196,
    VPSHUFLW = 1197,
    VPSIGNB = 1198,
    VPSIGND = 1199,
    VPSIGNW = 1200,
    VPSLLDQ = 1201,
    VPSLLD = 1202,
    VPSLLQ = 1203,
    VPSLLVD = 1204,
    VPSLLVQ = 1205,
    VPSLLW = 1206,
    VPSRAD = 1207,
    VPSRAQ = 1208,
    VPSRAVD = 1209,
    VPSRAVQ = 1210,
    VPSRAW = 1211,
    VPSRLDQ = 1212,
    VPSRLD = 1213,
    VPSRLQ = 1214,
    VPSRLVD = 1215,
    VPSRLVQ = 1216,
    VPSRLW = 1217,
    VPSUBB = 1218,
    VPSUBD = 1219,
    VPSUBQ = 1220,
    VPSUBSB = 1221,
    VPSUBSW = 1222,
    VPSUBUSB = 1223,
    VPSUBUSW = 1224,
    VPSUBW = 1225,
    VPTESTMD = 1226,
    VPTESTMQ = 1227,
    VPTESTNMD = 1228,
    VPTESTNMQ = 1229,
    VPTEST = 1230,
    VPUNPCKHBW = 1231,
    VPUNPCKHDQ = 1232,
    VPUNPCKHQDQ = 1233,
    VPUNPCKHWD = 1234,
    VPUNPCKLBW = 1235,
    VPUNPCKLDQ = 1236,
    VPUNPCKLQDQ = 1237,
    VPUNPCKLWD = 1238,
    VPXORD = 1239,
    VPXORQ = 1240,
    VPXOR = 1241,
    VRCP14PD = 1242,
    VRCP14PS = 1243,
    VRCP14SD = 1244,
    VRCP14SS = 1245,
    VRCP28PD = 1246,
    VRCP28PS = 1247,
    VRCP28SD = 1248,
    VRCP28SS = 1249,
    VRCPPS = 1250,
    VRCPSS = 1251,
    VRNDSCALEPD = 1252,
    VRNDSCALEPS = 1253,
    VRNDSCALESD = 1254,
    VRNDSCALESS = 1255,
    VROUNDPD = 1256,
    VROUNDPS = 1257,
    VROUNDSD = 1258,
    VROUNDSS = 1259,
    VRSQRT14PD = 1260,
    VRSQRT14PS = 1261,
    VRSQRT14SD = 1262,
    VRSQRT14SS = 1263,
    VRSQRT28PD = 1264,
    VRSQRT28PS = 1265,
    VRSQRT28SD = 1266,
    VRSQRT28SS = 1267,
    VRSQRTPS = 1268,
    VRSQRTSS = 1269,
    VSCATTERDPD = 1270,
    VSCATTERDPS = 1271,
    VSCATTERPF0DPD = 1272,
    VSCATTERPF0DPS = 1273,
    VSCATTERPF0QPD = 1274,
    VSCATTERPF0QPS = 1275,
    VSCATTERPF1DPD = 1276,
    VSCATTERPF1DPS = 1277,
    VSCATTERPF1QPD = 1278,
    VSCATTERPF1QPS = 1279,
    VSCATTERQPD = 1280,
    VSCATTERQPS = 1281,
    VSHUFPD = 1282,
    VSHUFPS = 1283,
    VSQRTPD = 1284,
    VSQRTPS = 1285,
    VSQRTSD = 1286,
    VSQRTSS = 1287,
    VSTMXCSR = 1288,
    VSUBPD = 1289,
    VSUBPS = 1290,
    VSUBSD = 1291,
    VSUBSS = 1292,
    VTESTPD = 1293,
    VTESTPS = 1294,
    VUNPCKHPD = 1295,
    VUNPCKHPS = 1296,
    VUNPCKLPD = 1297,
    VUNPCKLPS = 1298,
    VZEROALL = 1299,
    VZEROUPPER = 1300,
    WAIT = 1301,
    WBINVD = 1302,
    WRFSBASE = 1303,
    WRGSBASE = 1304,
    WRMSR = 1305,
    XABORT = 1306,
    XACQUIRE = 1307,
    XBEGIN = 1308,
    XCHG = 1309,
    XCRYPTCBC = 1310,
    XCRYPTCFB = 1311,
    XCRYPTCTR = 1312,
    XCRYPTECB = 1313,
    XCRYPTOFB = 1314,
    XEND = 1315,
    XGETBV = 1316,
    XLATB = 1317,
    XRELEASE = 1318,
    XRSTOR = 1319,
    XRSTOR64 = 1320,
    XRSTORS = 1321,
    XRSTORS64 = 1322,
    XSAVE = 1323,
    XSAVE64 = 1324,
    XSAVEC = 1325,
    XSAVEC64 = 1326,
    XSAVEOPT = 1327,
    XSAVEOPT64 = 1328,
    XSAVES = 1329,
    XSAVES64 = 1330,
    XSETBV = 1331,
    XSHA1 = 1332,
    XSHA256 = 1333,
    XSTORE = 1334,
    XTEST = 1335,
    FDISI8087_NOP = 1336,
    FENI8087_NOP = 1337,
    ENDING = 1338
}

export type X86InstructionName = keyof typeof X86InstructionCode

export const X86InstructionNames = enumKeys(X86InstructionCode) as X86InstructionName[]