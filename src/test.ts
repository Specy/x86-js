import {X86Interpreter, X86Register} from '../dist/index.js'


const interpreter = X86Interpreter.create(`
mov   eax, 0
mov   edx, 1
mov   ecx, 30
xadd  ecx, edx
`)

interpreter.assemble()
interpreter.initialize()
interpreter.simulate()




