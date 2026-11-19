import json, glob, math, os, datetime as dt
from collections import defaultdict
D='/tmp/claude-tool-results/dcbb19e4-848e-511b-ab99-c0fe5b7ae01b/'
def load(fn):
    outer=json.load(open(D+fn)); t=outer[0]['text']
    s,_=json.JSONDecoder().raw_decode(t)   # JSON string literal
    v=json.loads(s)
    return v['rows'] if isinstance(v,dict) else v
F={'03631':load('toolu_01QAFnp6hTByHaerZi2qZndN-ef66c662.json')+load('toolu_01GHYsmtyRYjv4o8j16AFgzD-2fddb221.json'),
   '03015':load('toolu_01EA2M9tkVf5Gt331j2zNq1n-1741af14.json')+load('toolu_01PN461R7CHbHwhNbEmM7nWr-36750131.json')}
# elevation per tc: recompute cheaply via node output? use rows.json (el 2-14) keyed by tc
R=json.load(open('rows.json'))
data=[]
for st,feat in F.items():
    sd={r[0]:(r[1],r[3]) for r in R[st]['rows']}
    miss=0
    for f in feat:
        tc,maxC,S,l0,m0,h0,mL,mM,mH,n=f
        if tc not in sd: miss+=1; continue
        el,sunmin=sd[tc]
        loc=None if min(l0,m0,h0)<0 else 100*(1-(1-l0/100)*(1-m0/100)*(1-h0/100))
        data.append(dict(st=st,tc=tc,el=el,sun=sunmin>=5,sunmin=sunmin,maxC=maxC,S=S,loc=loc,mL=mL,mM=mM,mH=mH))
    print(st,'feature rows',len(feat),'matched',len(feat)-miss)
print('totale',len(data),'frazione con sole',round(sum(d['sun'] for d in data)/len(data),3))
def tab(rows,key,bins):
    out=[]
    for a,b in bins:
        s=[d for d in rows if d[key] is not None and a<=d[key]<b]
        if s: out.append((f'{a:>3}-{b:<3}',len(s),round(100*sum(d['sun'] for d in s)/len(s))))
    return out
B=[(0,10),(10,20),(20,30),(30,40),(40,50),(50,60),(60,70),(70,80),(80,90),(90,101)]
print('\n1) Distorsione strumentale: cielo previsto sgombro lungo il raggio (maxC<10%), % intervalli con sole per elevazione')
for a,b in [(2,4),(4,6),(6,8),(8,10.1)]:
    s=[d for d in data if d['maxC']<10 and a<=d['el']<b]
    print(f'   el {a}-{b}°: n={len(s)}, sole {round(100*sum(d["sun"] for d in s)/max(1,len(s)))}%')
U=[d for d in data if d['el']>=4]
print(f'\n(analisi successive su el >= 4°: n={len(U)})')
print('\n2) Affidabilità: copertura massima lungo il raggio -> % osservata di sole')
for r in tab(U,'maxC',B): print('   maxC',*r)
print('\n   confronto: copertura totale sopra la stazione -> % sole')
for r in tab(U,'loc',B): print('   locale',*r)
def sweep(rows,key):
    best=None
    for T in range(5,100,5):
        tp=sum(1 for d in rows if d[key] is not None and d[key]<T and d['sun'])
        fn=sum(1 for d in rows if d[key] is not None and d[key]>=T and d['sun'])
        fp=sum(1 for d in rows if d[key] is not None and d[key]<T and not d['sun'])
        tn=sum(1 for d in rows if d[key] is not None and d[key]>=T and not d['sun'])
        H=tp/max(1,tp+fn); F_=fp/max(1,fp+tn); acc=(tp+tn)/max(1,tp+tn+fp+fn)
        pss=H-F_
        if best is None or pss>best[1]: best=(T,pss,acc,H,F_)
    return best
print('\n3) Soglia ottimale (Peirce skill score = tasso successi - tasso falsi allarmi), "sole" se valore < T')
for key in ['maxC','loc']:
    T,pss,acc,H,F_=sweep(U,key); print(f'   {key:5}: T={T}%  PSS={pss:.2f}  accuratezza={acc:.2f}  successi={H:.2f}  falsi allarmi={F_:.2f}')
for st in F:
    T,pss,acc,H,F_=sweep([d for d in U if d['st']==st],'maxC'); print(f'   maxC solo {st}: T={T}% PSS={pss:.2f} acc={acc:.2f}')
p0=sum(d['sun'] for d in U)/len(U)
brier=lambda pr: sum((pr(d)-d['sun'])**2 for d in U)/len(U)
bc=brier(lambda d:p0)
print(f'\n4) Probabilità: Brier climatologia={bc:.3f}')
bestL=min((brier(lambda d,L=L: math.exp(d['S']/L)),L) for L in [2,3,5,7,10,15,20,30,50,80,120])
print(f'   modello varchi P=exp(S/L): L migliore={bestL[1]} km, Brier={bestL[0]:.3f}, skill={1-bestL[0]/bc:.2f}')
# probabilità empirica per classe di maxC (tabella 2) come predittore (in-sample)
cls=defaultdict(list)
for d in U: cls[min(9,int(d['maxC']//10))].append(d['sun'])
pm={k:sum(v)/len(v) for k,v in cls.items()}
b2=brier(lambda d: pm[min(9,int(d['maxC']//10))]); print(f'   tabella maxC per classi: Brier={b2:.3f}, skill={1-b2/bc:.2f}')
cl2=defaultdict(list)
for d in U:
    if d['loc'] is not None: cl2[min(9,int(d['loc']//10))].append(d['sun'])
pl={k:sum(v)/len(v) for k,v in cl2.items()}
b3=sum((pl[min(9,int(d['loc']//10))]-d['sun'])**2 for d in U if d['loc'] is not None)/len([d for d in U if d['loc'] is not None])
print(f'   tabella copertura locale: Brier={b3:.3f}, skill={1-b3/bc:.2f}')
json.dump(dict(rel=tab(U,'maxC',B),loc=tab(U,'loc',B)),open('summary.json','w'))

print('\n5) Validazione incrociata tra stazioni (taro su una, verifico sull\'altra)')
for tr,te in [('03631','03015'),('03015','03631')]:
    A=[d for d in U if d['st']==tr]; Bt=[d for d in U if d['st']==te]
    L=min([2,3,5,7,10,15,20,30,40,50,60,80,120],key=lambda L: sum((math.exp(d['S']/L)-d['sun'])**2 for d in A))
    pc=sum(d['sun'] for d in A)/len(A)
    bt=sum((math.exp(d['S']/L)-d['sun'])**2 for d in Bt)/len(Bt); bcl=sum((pc-d['sun'])**2 for d in Bt)/len(Bt)
    print(f'   taratura {tr} -> L={L} km; su {te}: Brier={bt:.3f}, climatologia={bcl:.3f}, skill={1-bt/bcl:.2f}')
# affidabilità del modello varchi L=50
print('\n6) Affidabilità del modello P=exp(S/50): probabilità prevista -> frequenza osservata')
bins=defaultdict(list)
for d in U: bins[min(9,int(10*math.exp(d['S']/50)))].append(d['sun'])
for k in sorted(bins): print(f'   P {k*10:>2}-{k*10+10:<3}% n={len(bins[k]):4}  osservato {round(100*sum(bins[k])/len(bins[k]))}%')
