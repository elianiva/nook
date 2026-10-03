import './styles.css'
import { Runtime } from 'foldkit'
import { Model } from './counter/model'
import { init, update } from './counter/update'
import { view } from './counter/view'

const program = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById('root'),
})

Runtime.run(program)
