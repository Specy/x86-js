import {X86Interpreter} from '../dist/index.mjs'


const interpreter = X86Interpreter.create(`
mov   eax, 0
mov   edx, 1
mov   ecx, 30
xadd  ecx, ec
`)

try{
    interpreter.assemble()
    interpreter.initialize()
    interpreter.simulate()
}catch (e){
}


